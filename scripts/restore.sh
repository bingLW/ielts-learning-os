#!/bin/bash
# =============================================================================
# IELTS Learning OS —— 从 DB + uploads bundle 安全恢复
# -----------------------------------------------------------------------------
# 默认安全用法（只写入 /tmp 新目录，绝不覆盖当前用户库）：
#   bash scripts/restore.sh backups/dev-YYYYMMDD-HHMMSS.tar
#   bash scripts/restore.sh <bundle.tar> --target /tmp/ielts-restored-copy
#
# 显式覆盖（高风险；先完整校验，再要求输入 y 和 RESTORE）：
#   bash scripts/restore.sh <bundle.tar> --target "$PWD" --overwrite
#
# 整体 checksum 默认取 <bundle.tar>.sha256，可用 --checksums 指定；缺一不可。
# 旧版裸 dev-*.db 没有 manifest/checksums，按设计拒绝恢复。
#
# 执行顺序：
#   1) 校验外部整体 sha256、tar header/路径/类型/大小/条目数；
#   2) 校验 manifest 与 checksums.sha256 文件清单完全一致，缺一不可；
#   3) 在 /tmp 私有暂存区逐文件验证大小/sha256，再验证 SQLite integrity、
#      foreign_key_check、schema/AppMigration/app 版本及全表行数；
#   4) 默认发布到新 /tmp 目录；覆盖模式必须显式 --target + --overwrite，
#      并通过两步确认，且拒绝目标 DB 的 -wal/-shm/-journal 残留；
#   5) 覆盖前把原 DB + uploads 移动到目标目录下的 .ielts-before-restore-*，
#      发布失败自动回滚；成功后的手动回滚命令：
#        bash scripts/restore.sh --rollback <SAFETY目录> --target <目标目录>
#
# 上传文件只接受普通文件；拒绝绝对路径、..、空段、反斜杠、symlink、hardlink、
# 目录/设备等特殊 tar 条目、重复条目、超限与任何清单外文件。
# 依赖：/usr/bin/sqlite3、Node.js（仅内置模块）和 POSIX shell；不引入新依赖。
# =============================================================================

set -euo pipefail
PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH

SQLITE3="${IELTS_SQLITE3:-/usr/bin/sqlite3}"
NODE_BIN="${NODE_BIN:-node}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUNDLE_HELPER="$SCRIPT_DIR/backup-bundle.mjs"
STATE=""

usage() {
  printf '%s\n' \
    "用法：bash scripts/restore.sh <bundle.tar> [--checksums <file>] [--target <目录>] [--overwrite]" \
    "" \
    "  默认                恢复到 /tmp/ielts-restore-* 新目录，不覆盖任何现有库" \
    "  --target <目录>     必须是新目录或空目录；覆盖则还必须显式 --overwrite" \
    "  --overwrite         高风险：两步确认后覆盖目标 DB + storage/uploads" \
    "  --allow-version-mismatch  显式允许 bundle 与当前代码版本不同（不跳过库内版本自检）" \
    "  --rollback <SAFETY> --target <目录>  从覆盖前安全网手动回滚（同样两步确认）" \
    "" \
    "整体 checksum 默认读取 <bundle.tar>.sha256；bundle、manifest、checksums 缺一不可。" \
    "覆盖前请停止应用；目标 DB 旁有 WAL/SHM/journal 残留时脚本拒绝执行。" \
    "环境变量：NODE_BIN / IELTS_SQLITE3；不再接受 IELTS_DB_PATH（避免误覆盖真实库）。"
}

die() { printf '错误：%s\n' "$1" >&2; exit 1; }
cleanup() {
  if [ -n "$STATE" ]; then
    "$NODE_BIN" "$BUNDLE_HELPER" cleanup --state "$STATE" >/dev/null 2>&1 || true
    rm -f "$STATE"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

abs_target() {
  local p="$1" d b
  d="$(dirname "$p")"
  b="$(basename "$p")"
  [ -d "$d" ] || return 1
  d="$(cd "$d" && pwd)" || return 1
  printf '%s/%s' "$d" "$b"
}
confirm_overwrite() {
  local ans1 ans2
  printf '【警告】将覆盖目标 DB 与 storage/uploads。请先停止开发服务器/生产服务。\n'
  printf '第 1 步确认：输入 y 继续：'
  IFS= read -r ans1 || die '未读取到确认输入，目标未改动'
  [ "$ans1" = y ] || die '输入不是 y，目标未改动'
  printf '第 2 步确认：输入 RESTORE（全大写）：'
  IFS= read -r ans2 || die '未读取到确认输入，目标未改动'
  [ "$ans2" = RESTORE ] || die '输入不是 RESTORE，目标未改动'
}

TARGET=""
CHECKSUMS=""
OVERWRITE=0
ALLOW_MISMATCH=0
ROLLBACK=""
BUNDLE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      [ "$#" -ge 2 ] || die '--target 缺少目录参数'
      TARGET="$2"; shift 2 ;;
    --checksums)
      [ "$#" -ge 2 ] || die '--checksums 缺少文件参数'
      CHECKSUMS="$2"; shift 2 ;;
    --rollback)
      [ "$#" -ge 2 ] || die '--rollback 缺少 SAFETY 目录'
      ROLLBACK="$2"; shift 2 ;;
    --overwrite) OVERWRITE=1; shift ;;
    --allow-version-mismatch) ALLOW_MISMATCH=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; [ "$#" -le 1 ] || die '位置参数过多'; BUNDLE="${1:-}"; [ "$#" -eq 0 ] || shift ;;
    -*) die "未知参数：$1" ;;
    *) [ -z "$BUNDLE" ] || die '位置参数过多'; BUNDLE="$1"; shift ;;
  esac
done

[ -x "$SQLITE3" ] || die "找不到可执行的 sqlite3：$SQLITE3"
command -v "$NODE_BIN" >/dev/null 2>&1 || die "找不到 Node：$NODE_BIN"
[ -f "$BUNDLE_HELPER" ] || die "缺少 helper：$BUNDLE_HELPER"
[ -z "${IELTS_DB_PATH:-}" ] || die 'IELTS_DB_PATH 已停用；默认只恢复到 /tmp，覆盖请显式 --target <目录> --overwrite'

if [ -n "$ROLLBACK" ]; then
  [ -z "$BUNDLE" ] || die '--rollback 不能同时指定 bundle'
  [ -n "$TARGET" ] || die '--rollback 必须同时指定 --target'
  TARGET="$(abs_target "$TARGET")" || die '回滚目标目录不存在'
  confirm_overwrite
  "$NODE_BIN" "$BUNDLE_HELPER" rollback --safety "$ROLLBACK" --target "$TARGET" --confirmed
  exit 0
fi

[ -n "$BUNDLE" ] || { usage >&2; exit 2; }
[ -f "$BUNDLE" ] || die "bundle 不存在：$BUNDLE"
BUNDLE="$(cd "$(dirname "$BUNDLE")" && pwd)/$(basename "$BUNDLE")"
if [ -z "$CHECKSUMS" ]; then
  CHECKSUMS="$BUNDLE.sha256"
fi
[ -f "$CHECKSUMS" ] || die "整体 checksum 缺失：$CHECKSUMS（与 bundle 同时保存，缺一不可）"
CHECKSUMS="$(cd "$(dirname "$CHECKSUMS")" && pwd)/$(basename "$CHECKSUMS")"
[ "$OVERWRITE" -eq 0 ] || [ -n "$TARGET" ] || die '--overwrite 必须同时显式给出 --target；默认 /tmp 恢复无需覆盖'

STATE="$(mktemp /tmp/ielts-restore-state-XXXXXX)"
PREPARE_ARGS=(--bundle "$BUNDLE" --checksums "$CHECKSUMS" --state "$STATE")
if [ "$ALLOW_MISMATCH" -eq 1 ]; then
  PREPARE_ARGS+=(--allow-version-mismatch)
fi
printf 'IELTS Learning OS / bundle 校验（此时尚未写入目标目录）\n'
"$NODE_BIN" "$BUNDLE_HELPER" prepare "${PREPARE_ARGS[@]}"

if [ -z "$TARGET" ]; then
  TARGET="$(mktemp -d /tmp/ielts-restore-XXXXXX)"
  printf '\n默认安全恢复：新建临时目录 %s（不覆盖当前用户库）\n' "$TARGET"
else
  TARGET="$(abs_target "$TARGET")" || die "目标父目录不存在：$TARGET"
  if [ "$OVERWRITE" -eq 1 ]; then
    confirm_overwrite
  fi
fi

PUBLISH_ARGS=(--state "$STATE" --target "$TARGET")
if [ "$OVERWRITE" -eq 1 ]; then
  PUBLISH_ARGS+=(--overwrite --confirmed)
fi
"$NODE_BIN" "$BUNDLE_HELPER" publish "${PUBLISH_ARGS[@]}"
printf '\n恢复目标：%s\n' "$TARGET"
printf '数据库：%s/prisma/dev.db\n' "$TARGET"
printf '上传文件：%s/storage/uploads\n' "$TARGET"
printf '如为覆盖恢复，请重启应用；回滚须先停应用，再使用 --rollback <SAFETY> --target <目标目录>。\n'
