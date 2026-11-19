#!/bin/bash
# =============================================================================
# IELTS Learning OS —— 从一致性备份恢复 SQLite 库
# -----------------------------------------------------------------------------
# 用法：
#   bash scripts/restore.sh <backup-file>
#   IELTS_DB_PATH=/tmp/ielts-restore-probe.db bash scripts/restore.sh backups/dev-....db
#   printf 'y\nRESTORE\n' | bash scripts/restore.sh backups/dev-....db   # 非交互演练
#
# 执行顺序：
#   1) 校验备份文件存在，且它自身的 PRAGMA integrity_check = ok
#   2) 读取备份里四张关键表的行数，作为恢复后的比对基准
#   3) 目标库旁若存在 -wal / -shm / -journal 残留，打印处理指引并以非 0 中止（不动目标库）
#   4) 打印风险提示，做两步交互确认（先 y，再输入全大写 RESTORE；首尾空白同样拒绝）
#   5) 把当前库另存为 <db>.before-restore-<timestamp>（覆盖前安全网）
#   6) 用 sqlite3 .backup 把备份展开成临时文件并自检，再 mv 覆盖目标库
#   7) 恢复后再跑 PRAGMA integrity_check + 四表行数比对；失败则打印回退指引
#
# 为什么全程不用 cp：
#   覆盖前的「安全网」同样来自一个可能正在被写入的库，直接 cp 会遇到和备份一样
#   的 WAL / 跨语句原子性问题；恢复本身也用 .backup 生成一致性副本再 mv 发布，
#   避免把备份文件逐字节拷进一个可能被进程打开的目标文件。
#
# 快照方式：与 backup.sh 一致，默认 .backup，失败时自动退化 VACUUM INTO；
#           可用 IELTS_SNAPSHOT_METHOD 指定 auto / backup / vacuum。
#
# 依赖：仅 /usr/bin/sqlite3 与 POSIX shell 工具；绝不调用 node / npm / npx / tsx / prisma。
# 兼容：macOS 自带 /bin/bash 3.2；不使用 bash 4+ 特性。
# =============================================================================

set -euo pipefail

PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

SQLITE3=/usr/bin/sqlite3
KEY_TABLES="stage stageAcceptanceItem resource studySession"
METHOD="${IELTS_SNAPSHOT_METHOD:-auto}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_PATH="${IELTS_DB_PATH:-$PROJECT_ROOT/prisma/dev.db}"

SAFETY=""
TMP_SAFETY=""
TMP_RESTORE=""
ABORTED_TMP=""

usage() {
  printf '%s\n' \
    "用法：bash scripts/restore.sh <backup-file>" \
    "" \
    "示例：bash scripts/restore.sh backups/dev-20261109-090000.db" \
    "演练：IELTS_DB_PATH=/tmp/ielts-restore-probe.db bash scripts/restore.sh backups/dev-....db" \
    "" \
    "会做两步交互确认：先输入 y，再输入全大写 RESTORE；其它任何输入（含首尾带空白的" \
    " y / RESTORE ）都直接取消，目标库不动。" \
    "非交互场景可用：printf 'y\\nRESTORE\\n' | bash scripts/restore.sh <备份文件>" \
    "" \
    "注意：目标库旁若存在 -wal / -shm / -journal 残留会直接中止，需先停应用并手工清理。" \
    "" \
    "环境变量：IELTS_DB_PATH（覆盖目标库，默认 \$PROJECT_ROOT/prisma/dev.db）" \
    "          IELTS_SNAPSHOT_METHOD（auto / backup / vacuum）"
}

abs_path() {
  local p="$1"
  local d b
  d="$(cd "$(dirname "$p")" && pwd)" || return 1
  b="$(basename "$p")"
  printf '%s/%s' "$d" "$b"
}

# 统一以 list 模式、无表头调用 sqlite3，避免宿主默认 qbox/box 输出影响解析。
sq() {
  "$SQLITE3" -batch -noheader -list "$@"
}

# 从 src 生成一份一致性快照到 dst（相对文件名，由本脚本生成、不含特殊字符）。
# 首选 .backup；若目标目录不允许 SQLite 创建并删除 -journal，则自动退化 VACUUM INTO。
make_snapshot() {
  local src="$1" dst="$2" alt
  if [ "$METHOD" != "vacuum" ]; then
    if sq "$src" ".backup '$dst'" 2>/dev/null; then
      return 0
    fi
    ABORTED_TMP="$dst"
  fi
  if [ "$METHOD" = "backup" ]; then
    return 1
  fi
  # 失败的 .backup 可能留下热回滚日志；必须先清掉，否则新文件会被旧日志污染。
  if [ -e "$dst-journal" ]; then
    if ! rm -f "$dst-journal" 2>/dev/null; then
      printf '警告：无法清除残留回滚日志 %s，已中止\n' "$dst-journal" >&2
      return 1
    fi
  fi
  alt="$dst.vacuum"
  if sq "$src" "VACUUM INTO '$alt';" 2>/dev/null; then
    if mv -f "$alt" "$dst"; then
      ABORTED_TMP=""
      return 0
    fi
  fi
  return 1
}

# 只清理本次执行遗留的临时文件；已发布的备份与安全网一律不动。
cleanup() {
  local f
  for f in "$TMP_SAFETY" "$TMP_SAFETY.vacuum" "$TMP_RESTORE" \
           "$TMP_RESTORE.vacuum" "$ABORTED_TMP"; do
    if [ -n "$f" ] && [ -e "$f" ]; then
      if ! rm -f "$f" 2>/dev/null; then
        printf '警告：无法删除残留临时文件 %s，请手工清理\n' "$f" >&2
      fi
    fi
  done
}
trap cleanup EXIT

# 自检失败时给出明确的回退命令，不做任何自动覆盖。
rollback_hint() {
  printf '\n== 回退指引 ==\n'
  if [ -n "$SAFETY" ]; then
    printf '覆盖前安全网仍在：%s/%s\n' "$DB_DIR" "$SAFETY"
    printf '执行以下命令即可回退（会再次要求两步确认）：\n'
    printf '  bash %s/restore.sh "%s/%s"\n' "$SCRIPT_DIR" "$DB_DIR" "$SAFETY"
  else
    printf '目标库原本不存在，没有覆盖前安全网；如需撤销请自行删除 %s\n' "$DB_PATH"
  fi
  printf '回退前请先确认应用已完全停止。\n'
}

# ------------------------------ 参数与前置校验 ------------------------------
if [ "$#" -ne 1 ]; then
  usage >&2
  exit 2
fi
case "$1" in
  -h|--help) usage; exit 0 ;;
esac
BACKUP_FILE="$1"

if [ ! -x "$SQLITE3" ]; then
  printf '错误：找不到可执行的 %s\n' "$SQLITE3" >&2
  exit 1
fi
if [ ! -f "$BACKUP_FILE" ]; then
  printf '错误：备份文件不存在：%s\n' "$BACKUP_FILE" >&2
  exit 1
fi
BACKUP_FILE="$(abs_path "$BACKUP_FILE")" || {
  printf '错误：无法解析备份文件路径 %s\n' "$BACKUP_FILE" >&2
  exit 1
}

chk="$(sq "$BACKUP_FILE" "PRAGMA integrity_check;" 2>/dev/null)" || {
  printf '错误：备份文件无法执行 PRAGMA integrity_check：%s\n' "$BACKUP_FILE" >&2
  exit 1
}
if [ "$chk" != "ok" ]; then
  printf '错误：备份文件 PRAGMA integrity_check 返回「%s」（期望 ok），拒绝恢复\n' "$chk" >&2
  exit 1
fi

# 以备份文件里的行数作为恢复后的比对基准。
BASELINE=""
for tbl in $KEY_TABLES; do
  n="$(sq "$BACKUP_FILE" "SELECT count(*) FROM \"$tbl\";" 2>/dev/null)" || {
    printf '错误：备份文件缺少关键表 %s（或该表不可读），拒绝恢复\n' "$tbl" >&2
    exit 1
  }
  BASELINE="$BASELINE|$tbl=$n"
done

DB_PATH="$(abs_path "$DB_PATH")" || {
  printf '错误：无法解析目标库路径 %s\n' "$DB_PATH" >&2
  exit 1
}
DB_DIR="$(dirname "$DB_PATH")"
DB_BASE="$(basename "$DB_PATH")"
if [ ! -d "$DB_DIR" ]; then
  printf '错误：目标库所在目录不存在：%s\n' "$DB_DIR" >&2
  exit 1
fi

case "$METHOD" in
  auto|backup|vacuum) ;;
  *)
    printf '警告：IELTS_SNAPSHOT_METHOD=%s 无效，按 auto 处理\n' "$METHOD" >&2
    METHOD=auto
    ;;
esac

# ------------------------------ WAL / 热 journal 残留硬中止 -----------------
# 恢复只替换主库文件。若旁边残留 -wal / -shm / -journal，SQLite 下次打开时会把
# 旧 WAL 帧 / 回滚日志应用到新主库上，可能污染恢复结果，因此必须中止而不能只警告。
# 本脚本绝不自动移动或删除这些残留（避免引入新的破坏性行为）。
SIDECAR_FOUND=0
for suffix in -wal -shm -journal; do
  if [ -e "$DB_PATH$suffix" ]; then
    SIDECAR_FOUND=1
    printf '检测到伴随残留：%s%s\n' "$DB_PATH" "$suffix" >&2
  fi
done
if [ "$SIDECAR_FOUND" -eq 1 ]; then
  printf '\n错误：目标库旁存在 WAL / 回滚日志残留，已中止恢复（目标库完全未改动，也未生成安全网）。\n' >&2
  printf '处理步骤：\n' >&2
  printf '  1) 先停应用：关闭 npm run dev / next start，确认没有进程占用该数据库；\n' >&2
  printf '  2) 手工清理或移走以下残留（本脚本不会自动移动或删除它们）：\n' >&2
  printf '       %s-wal / %s-shm / %s-journal\n' "$DB_PATH" "$DB_PATH" "$DB_PATH" >&2
  printf '  3) 再重新执行：bash %s/restore.sh <备份文件>\n' "$SCRIPT_DIR" >&2
  exit 1
fi

# ------------------------------ 风险提示与二次确认 --------------------------
printf 'IELTS Learning OS / SQLite 恢复\n'
printf '  备份文件：%s\n' "$BACKUP_FILE"
printf '  目标库  ：%s\n' "$DB_PATH"
printf '  备份自检：integrity_check = ok；基准行数 %s\n' "$BASELINE"
printf '\n'
printf '【警告】恢复会用备份内容覆盖当前数据库，属于高风险操作（虽有覆盖前安全网）。\n'
printf '        执行前请确认应用已停止（开发服务器 / 生产服务全部关闭，见 README §11.4）；\n'
printf '        恢复后必须重启应用，否则进程仍持有旧文件的 inode，看到的是旧数据。\n'
printf '\n'
printf '第 1 步确认：输入 y 继续（其它任何输入都取消）：'
if ! IFS= read -r ans1; then
  printf '\n已取消：未读取到确认输入。\n'
  exit 1
fi
if [ "$ans1" != "y" ]; then
  printf '\n已取消：输入不是 y，目标库未被改动。\n'
  exit 1
fi
printf '第 2 步确认：请输入 RESTORE（全大写）以执行覆盖：'
if ! IFS= read -r ans2; then
  printf '\n已取消：未读取到确认输入。\n'
  exit 1
fi
if [ "$ans2" != "RESTORE" ]; then
  printf '\n已取消：输入不是 RESTORE，目标库未被改动。\n'
  exit 1
fi
printf '\n'

# ------------------------------ 覆盖前安全网 --------------------------------
cd "$DB_DIR" || {
  printf '错误：无法进入目标库目录 %s\n' "$DB_DIR" >&2
  exit 1
}

STAMP="$(date +%Y%m%d-%H%M%S)"
TMP_SAFETY=".ielts-safety-$STAMP-$$.db"
TMP_RESTORE=".ielts-restore-$STAMP-$$.db"

if [ -f "$DB_BASE" ]; then
  SAFETY="$DB_BASE.before-restore-$STAMP"
  SEQ=2
  while [ -e "$SAFETY" ]; do
    SAFETY="$DB_BASE.before-restore-$STAMP-$SEQ"
    SEQ=$((SEQ + 1))
  done
  printf '正在把当前库另存为覆盖前安全网：%s\n' "$SAFETY"
  if ! make_snapshot "$DB_BASE" "$TMP_SAFETY"; then
    printf '错误：无法生成覆盖前安全网，已中止恢复（目标库未被改动）\n' >&2
    exit 1
  fi
  s_chk="$(sq "$TMP_SAFETY" "PRAGMA integrity_check;" 2>/dev/null)" || {
    printf '错误：覆盖前安全网自检失败，已中止恢复（目标库未被改动）\n' >&2
    exit 1
  }
  if [ "$s_chk" != "ok" ]; then
    printf '错误：覆盖前安全网 integrity_check = 「%s」，已中止恢复\n' "$s_chk" >&2
    exit 1
  fi
  mv -f "$TMP_SAFETY" "$SAFETY"
  TMP_SAFETY=""
  printf '安全网已保存：%s/%s\n\n' "$DB_DIR" "$SAFETY"
else
  printf '警告：目标库 %s 不存在，跳过覆盖前安全网（无需保护现有数据）。\n\n' "$DB_PATH"
fi

# ------------------------------ 执行恢复 ------------------------------------
# 先展开成临时文件并自检，通过后才 mv 覆盖；mv 在同一目录内是原子替换。
printf '正在从备份生成一致性副本并自检…\n'
if ! make_snapshot "$BACKUP_FILE" "$TMP_RESTORE"; then
  printf '错误：无法从备份生成恢复副本（目标库未被改动）\n' >&2
  rollback_hint
  exit 1
fi
r_chk="$(sq "$TMP_RESTORE" "PRAGMA integrity_check;" 2>/dev/null)" || {
  printf '错误：恢复副本自检失败（目标库未被改动）\n' >&2
  rollback_hint
  exit 1
}
if [ "$r_chk" != "ok" ]; then
  printf '错误：恢复副本 integrity_check = 「%s」（目标库未被改动）\n' "$r_chk" >&2
  rollback_hint
  exit 1
fi
printf '  integrity_check = ok\n'

ACTUAL=""
for tbl in $KEY_TABLES; do
  n="$(sq "$TMP_RESTORE" "SELECT count(*) FROM \"$tbl\";" 2>/dev/null)" || n="ERROR"
  ACTUAL="$ACTUAL|$tbl=$n"
  printf '  %-24s = %s\n' "$tbl" "$n"
done
if [ "$ACTUAL" != "$BASELINE" ]; then
  printf '错误：恢复副本行数与备份不一致（基准 %s / 实际 %s），目标库未被改动\n' "$BASELINE" "$ACTUAL" >&2
  rollback_hint
  exit 1
fi

mv -f "$TMP_RESTORE" "$DB_BASE"
TMP_RESTORE=""

# ------------------------------ 恢复后自检 ----------------------------------
printf '\n== 恢复后自检 ==\n'
final_chk="$(sq "$DB_BASE" "PRAGMA integrity_check;" 2>/dev/null)" || final_chk="ERROR"
if [ "$final_chk" != "ok" ]; then
  printf '错误：恢复后 PRAGMA integrity_check 返回「%s」\n' "$final_chk" >&2
  rollback_hint
  exit 1
fi
printf '  integrity_check = ok\n'

FINAL_ROWS=""
for tbl in $KEY_TABLES; do
  n="$(sq "$DB_BASE" "SELECT count(*) FROM \"$tbl\";" 2>/dev/null)" || n="ERROR"
  FINAL_ROWS="$FINAL_ROWS|$tbl=$n"
  printf '  %-24s = %s\n' "$tbl" "$n"
done
if [ "$FINAL_ROWS" != "$BASELINE" ]; then
  printf '错误：恢复后行数与备份不一致（基准 %s / 实际 %s）\n' "$BASELINE" "$FINAL_ROWS" >&2
  rollback_hint
  exit 1
fi

printf '\n== 恢复完成 ==\n'
printf '  目标库：%s\n' "$DB_PATH"
if [ -n "$SAFETY" ]; then
  printf '  覆盖前安全网：%s/%s\n' "$DB_DIR" "$SAFETY"
fi
printf '  下一步：重启应用（开发服务器 / 生产服务）。\n'
printf '  说明：恢复只替换数据页，不需要重新生成 Prisma Client，也不需要 db push。\n'

exit 0
