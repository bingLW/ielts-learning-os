#!/bin/bash
# =============================================================================
# IELTS Learning OS —— SQLite + storage/uploads 一致性备份 bundle
# -----------------------------------------------------------------------------
# 用法：
#   bash scripts/backup.sh                     # 生成一份备份并自检；绝不删除任何已有备份
#   bash scripts/backup.sh --prune            # 同上，并额外列出可清理的旧备份（仍不删除）
#   bash scripts/backup.sh --prune --yes      # 生成备份后，打印待删清单并成对清理旧 bundle
#
# 新产物：dev-<timestamp>.tar + dev-<timestamp>.tar.sha256（两者缺一不可）。
# tar 内必须有 manifest.json（逐文件相对路径/大小/sha256、schema/AppMigration、
# 创建时间、全表行数）与 checksums.sha256；外部 .sha256 校验整个 tar。
#
# 为什么不能用 cp 复制正在被写入的库（本脚本存在的核心理由）：
#   1) WAL 模式下，SQLite 数据库由 dev.db + dev.db-wal + dev.db-shm 三者共同构成。
#      已提交但尚未 checkpoint 的事务只存在于 -wal 里，`cp dev.db` 会静默丢掉它们，
#      得到一个「少了最近若干次写入」甚至根本打不开的文件。
#   2) 即便当前 PRAGMA journal_mode = delete（本仓库现状），cp 也只是逐字节搬运：
#      若复制期间应用正在执行跨多条语句的事务、或回滚日志 -journal 尚未清理，
#      cp 得到的可能是一个中间状态，无法保证跨语句写入的原子性。
#   3) sqlite3 的 .backup 走 SQLite 官方 sqlite3_backup_* API：在源库上按页复制并
#      持有读锁，产出的是一个自洽的、可直接打开的一致性快照；源库后续写入不影响它。
#      VACUUM INTO 是等价方案（需求明确允许）；.backup 按页原样复制、不改变 rowid，
#      因此作为首选，VACUUM INTO 作为失败时的自动退化方案。
#
# 实现要点：
#   - 先写到 *.db.partial 临时名，自检通过后才 mv 发布成 dev-*.db，
#     保证 backups/ 里永远不会出现「名字像备份、其实是坏的」文件。
#   - .backup 是 sqlite3 的点命令，其参数不支持 SQL 式的单引号转义（含 ' 的路径会
#     被误解析，已实测）。因此先 cd 进备份目录，点命令里只用本脚本生成的不含特殊
#     字符的相对文件名；发布阶段再用 mv，mv 可安全处理任意路径。
#   - 少数目标文件系统（部分网络盘 / 云同步目录 / 受管目录）不允许 SQLite 创建并
#     删除目标端的 -journal，.backup 会报 "disk I/O error"。此时自动改用 VACUUM INTO：
#     同样是一致性快照，但直接写目标文件、不需要回滚日志。可用 IELTS_SNAPSHOT_METHOD
#     指定 auto（默认）/ backup / vacuum，便于演练与排障。
#
# 依赖：/usr/bin/sqlite3、Node.js（仅内置模块）与 POSIX shell 工具。
#      不调用 npm / npx / tsx / prisma，不引入新依赖。Node 路径可用 NODE_BIN 指定。
# 兼容：macOS 自带 /bin/bash 3.2；不使用 ${var,,}、mapfile、&>> 等 bash 4+ 特性。
#
# 环境变量：
#   IELTS_DB_PATH      源库路径，默认 $PROJECT_ROOT/prisma/dev.db
#   IELTS_BACKUP_DIR   备份目录，默认 $PROJECT_ROOT/backups
#   IELTS_UPLOADS_DIR  uploads 源目录，默认 $PROJECT_ROOT/storage/uploads
#   IELTS_BACKUP_KEEP  保留份数上限，默认 14（只统计完整 bundle，默认不删除）
#   IELTS_SNAPSHOT_METHOD  auto（默认，.backup 失败自动退化 VACUUM INTO）/ backup / vacuum
# =============================================================================

set -euo pipefail

# launchd / cron 的默认 PATH 极窄，这里显式钉死系统路径，保证 sqlite3、date 等可找到。
PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH

SQLITE3="${IELTS_SQLITE3:-/usr/bin/sqlite3}"
NODE_BIN="${NODE_BIN:-node}"
KEY_TABLES="stage stageAcceptanceItem resource studySession"
KEEP="${IELTS_BACKUP_KEEP:-14}"
METHOD="${IELTS_SNAPSHOT_METHOD:-auto}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_PATH="${IELTS_DB_PATH:-$PROJECT_ROOT/prisma/dev.db}"
UPLOADS_DIR="${IELTS_UPLOADS_DIR:-$PROJECT_ROOT/storage/uploads}"
BACKUP_DIR="${IELTS_BACKUP_DIR:-$PROJECT_ROOT/backups}"
BUNDLE_HELPER="$SCRIPT_DIR/backup-bundle.mjs"

PRUNE_FLAG=0
YES_FLAG=0
PARTIAL=""
ABORTED_PARTIAL=""
CHECKSUM_PARTIAL=""
SNAPSHOT_PARTIAL=""
PUBLISHED_ARCHIVE=""

usage() {
  printf '%s\n' \
    "用法：bash scripts/backup.sh [--prune] [--yes]" \
    "" \
    "  （无参数）        生成一份一致性备份并自检；绝不删除任何已有备份" \
    "  --prune           额外列出超出保留上限的旧备份（仍不删除）" \
    "  --prune --yes     两者同时给出时，先打印完整待删清单，再逐文件 rm -f 清理" \
    "" \
    "环境变量：IELTS_DB_PATH / IELTS_UPLOADS_DIR / IELTS_BACKUP_DIR / IELTS_BACKUP_KEEP" \
    "          IELTS_SNAPSHOT_METHOD / NODE_BIN / IELTS_SQLITE3"
}

# 把可能是相对路径的入参解析成绝对路径；后面会 cd 进备份目录，相对路径会失效。
abs_path() {
  local p="$1"
  local d b
  d="$(cd "$(dirname "$p")" && pwd)" || return 1
  b="$(basename "$p")"
  printf '%s/%s' "$d" "$b"
}

# 统一以 list 模式、无表头调用 sqlite3。
# 原因：部分宿主把 sqlite3 shell 的默认输出设成 qbox/box 且带表头，直接比较
#       "ok" / 数字会失败；显式 -noheader -list 可得到稳定的纯文本。
sq() {
  "$SQLITE3" -batch -noheader -list "$@"
}

# 只删除本次执行遗留的半成品快照，绝不触碰任何已发布的备份。
# ABORTED_PARTIAL 是一次失败 .backup 留下的临时文件（可能还带 -journal 残留）。
#
# 为什么必须连 -journal / -wal / -shm 一起删：SQLite 在目标文件旁建回滚日志，
# 若进程被中断（Ctrl-C / 超时被杀），主文件与旁路文件都会留下。只删主文件会留下
# 0 字节的孤儿 -journal，下次自检若误把它当有效库打开，SQLite 会「自动回滚」
# 把快照截断（本机实测过）。因此旁路文件必须与主文件同生共死。
cleanup() {
  local f
  set -- "$PARTIAL" "$PARTIAL-journal" "$PARTIAL-wal" "$PARTIAL-shm" "$CHECKSUM_PARTIAL" \
    "$SNAPSHOT_PARTIAL" "$SNAPSHOT_PARTIAL-journal" "$SNAPSHOT_PARTIAL-wal" "$SNAPSHOT_PARTIAL-shm"
  if [ -n "$ABORTED_PARTIAL" ]; then
    set -- "$@" "$ABORTED_PARTIAL" "$ABORTED_PARTIAL-journal" \
      "$ABORTED_PARTIAL-wal" "$ABORTED_PARTIAL-shm"
  fi
  if [ -n "$PUBLISHED_ARCHIVE" ] && [ -e "$PUBLISHED_ARCHIVE" ]; then
    set -- "$@" "$PUBLISHED_ARCHIVE"
  fi
  for f in "$@"; do
    if [ -n "$f" ] && [ -e "$f" ]; then
      if rm -f "$f" 2>/dev/null; then
        printf '已删除不完整的临时产物：%s/%s\n' "$BACKUP_DIR" "$f" >&2
      else
        printf '警告：无法删除残留临时文件 %s/%s，请手工清理（它不是有效备份）\n' "$BACKUP_DIR" "$f" >&2
      fi
    fi
  done
}
trap cleanup EXIT
# 被信号中断时也走 EXIT，避免留下半成品
trap 'exit 130' INT
trap 'exit 143' TERM

# 对新生成的快照做完整自检：integrity/FK 必须通过，且四张关键表行数与源库一致。
verify_snapshot() {
  local src="$1" dst="$2" chk tbl n_src n_dst
  chk="$(sq "$dst" "PRAGMA integrity_check;" 2>/dev/null)" || {
    printf '自检失败：无法对快照执行 PRAGMA integrity_check\n' >&2
    return 1
  }
  if [ "$chk" != "ok" ]; then
    printf '自检失败：PRAGMA integrity_check 返回「%s」（期望 ok）\n' "$chk" >&2
    return 1
  fi
  printf '  integrity_check = ok\n'
  local fk
  fk="$(sq "$dst" "PRAGMA foreign_key_check;" 2>/dev/null)" || {
    printf '自检失败：无法执行 PRAGMA foreign_key_check\n' >&2
    return 1
  }
  if [ -n "$fk" ]; then
    printf '自检失败：foreign_key_check 存在违规：%s\n' "$fk" >&2
    return 1
  fi
  printf '  foreign_key_check = 无违规\n'
  for tbl in $KEY_TABLES; do
    n_src="$(sq "$src" "SELECT count(*) FROM \"$tbl\";" 2>/dev/null)" || {
      printf '自检失败：无法读取源库表 %s 行数\n' "$tbl" >&2
      return 1
    }
    n_dst="$(sq "$dst" "SELECT count(*) FROM \"$tbl\";" 2>/dev/null)" || {
      printf '自检失败：无法读取快照表 %s 行数\n' "$tbl" >&2
      return 1
    }
    if [ "$n_src" != "$n_dst" ]; then
      printf '自检失败：表 %s 行数不一致（源库 %s / 快照 %s）\n' "$tbl" "$n_src" "$n_dst" >&2
      return 1
    fi
    printf '  %-24s 源库=%-6s 快照=%-6s 一致\n' "$tbl" "$n_src" "$n_dst"
  done
  return 0
}

# ------------------------------ 参数解析 ------------------------------------
for arg in "$@"; do
  case "$arg" in
    --prune)    PRUNE_FLAG=1 ;;
    --yes)      YES_FLAG=1 ;;
    -h|--help)  usage; exit 0 ;;
    *)          printf '错误：未知参数 %s\n\n' "$arg" >&2; usage >&2; exit 2 ;;
  esac
done

# ------------------------------ 前置检查 ------------------------------------
if [ ! -x "$SQLITE3" ]; then
  printf '错误：找不到可执行的 %s\n' "$SQLITE3" >&2
  exit 1
fi
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  printf '错误：找不到 Node：%s（可用 NODE_BIN 指定绝对路径）\n' "$NODE_BIN" >&2
  exit 1
fi
if [ ! -f "$BUNDLE_HELPER" ]; then
  printf '错误：缺少 bundle helper：%s\n' "$BUNDLE_HELPER" >&2
  exit 1
fi
DB_PATH="$(abs_path "$DB_PATH")" || {
  printf '错误：无法解析源库路径 %s\n' "$DB_PATH" >&2
  exit 1
}
if [ ! -f "$DB_PATH" ]; then
  printf '错误：源库不存在：%s\n' "$DB_PATH" >&2
  exit 1
fi
UPLOADS_DIR="$(abs_path "$UPLOADS_DIR")" || {
  printf '错误：无法解析 uploads 路径 %s\n' "$UPLOADS_DIR" >&2
  exit 1
}
if ! mkdir -p "$BACKUP_DIR"; then
  printf '错误：无法创建备份目录：%s\n' "$BACKUP_DIR" >&2
  exit 1
fi
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"

# 源库自身先过一遍完整性检查，避免把已损坏的数据「成功地」备份下来。
src_chk="$(sq "$DB_PATH" "PRAGMA integrity_check;" 2>/dev/null)" || {
  printf '错误：源库无法执行 PRAGMA integrity_check：%s\n' "$DB_PATH" >&2
  exit 1
}
if [ "$src_chk" != "ok" ]; then
  printf '错误：源库 PRAGMA integrity_check 返回「%s」，已中止备份\n' "$src_chk" >&2
  exit 1
fi
src_fk="$(sq "$DB_PATH" "PRAGMA foreign_key_check;" 2>/dev/null)" || {
  printf '错误：源库无法执行 PRAGMA foreign_key_check，已中止备份\n' >&2
  exit 1
}
if [ -n "$src_fk" ]; then
  printf '错误：源库 foreign_key_check 存在违规，已中止备份：%s\n' "$src_fk" >&2
  exit 1
fi

case "$KEEP" in
  ''|*[!0-9]*)
    printf '警告：IELTS_BACKUP_KEEP=%s 不是非负整数，保留上限按 14 处理\n' "$KEEP" >&2
    KEEP=14
    ;;
esac

case "$METHOD" in
  auto|backup|vacuum) ;;
  *)
    printf '警告：IELTS_SNAPSHOT_METHOD=%s 无效，按 auto 处理\n' "$METHOD" >&2
    METHOD=auto
    ;;
esac

# ------------------------------ 生成快照 ------------------------------------
cd "$BACKUP_DIR" || {
  printf '错误：无法进入备份目录 %s\n' "$BACKUP_DIR" >&2
  exit 1
}

STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="dev-$STAMP.tar"
PARTIAL="dev-$STAMP.tar.partial"
CHECKSUM_PARTIAL="$PARTIAL.sha256"
SNAPSHOT_PARTIAL="dev-$STAMP.db.partial"
SEQ=2
while [ -e "$NAME" ] || [ -e "$NAME.sha256" ] || [ -e "$PARTIAL" ] || [ -e "$CHECKSUM_PARTIAL" ] || [ -e "$SNAPSHOT_PARTIAL" ]; do
  NAME="dev-$STAMP-$SEQ.tar"
  PARTIAL="dev-$STAMP-$SEQ.tar.partial"
  CHECKSUM_PARTIAL="$PARTIAL.sha256"
  SNAPSHOT_PARTIAL="dev-$STAMP-$SEQ.db.partial"
  SEQ=$((SEQ + 1))
done

printf 'IELTS Learning OS / SQLite + uploads 一致性备份\n'
printf '  源库      ：%s\n' "$DB_PATH"
printf '  备份目录  ：%s\n' "$BACKUP_DIR"
printf '  目标文件  ：%s\n' "$NAME"
printf '  uploads   ：%s\n' "$UPLOADS_DIR"
printf '  生成方式  ：sqlite3 .backup / VACUUM INTO + 安全 ustar bundle（非 cp）\n'
printf '\n'

SNAPSHOT_OK=0
if [ "$METHOD" != "vacuum" ]; then
  if sq "$DB_PATH" ".backup '$SNAPSHOT_PARTIAL'" 2>/dev/null; then
    SNAPSHOT_OK=1
  else
    ABORTED_PARTIAL="$SNAPSHOT_PARTIAL"
    printf '提示：.backup 未成功，自动改用等价的一致性快照方案 VACUUM INTO 重试…\n' >&2
  fi
fi

if [ "$SNAPSHOT_OK" -ne 1 ]; then
  VAC_PARTIAL="$SNAPSHOT_PARTIAL.vacuum"
  VSEQ=2
  while [ -e "$VAC_PARTIAL" ]; do
    VAC_PARTIAL="$SNAPSHOT_PARTIAL.vacuum-$VSEQ"
    VSEQ=$((VSEQ + 1))
  done
  if [ "$METHOD" != "backup" ] && sq "$DB_PATH" "VACUUM INTO '$VAC_PARTIAL';" 2>/dev/null; then
    SNAPSHOT_PARTIAL="$VAC_PARTIAL"
    SNAPSHOT_OK=1
  fi
fi

if [ "$SNAPSHOT_OK" -ne 1 ] || [ ! -f "$SNAPSHOT_PARTIAL" ]; then
  printf '错误：一致性快照生成失败，未产出任何备份\n' >&2
  exit 1
fi

printf '== 备份自检 ==\n'
if verify_snapshot "$DB_PATH" "$SNAPSHOT_PARTIAL"; then
  printf '自检通过。\n\n'
else
  printf '错误：备份自检未通过，已放弃本次产物（不会留在 backups/）。\n' >&2
  exit 1
fi

# 在私有暂存目录固化 uploads，再生成 manifest/checksums 和安全 ustar。
# helper 会拒绝 symlink/特殊文件/超限文件，并验证全表行数、integrity、FK、版本账本。
printf '== 生成 DB + uploads bundle ==\n'
if ! "$NODE_BIN" "$BUNDLE_HELPER" create \
  --db "$SNAPSHOT_PARTIAL" --uploads "$UPLOADS_DIR" --output "$PARTIAL" \
  --checksum-name "$NAME"; then
  printf '错误：bundle 生成或自检失败，未发布任何备份\n' >&2
  exit 1
fi
if [ ! -s "$PARTIAL" ] || [ ! -s "$CHECKSUM_PARTIAL" ]; then
  printf '错误：bundle 或整体 checksum 缺失，拒绝发布\n' >&2
  exit 1
fi

# 二次防覆盖：archive 与整体 checksum 必须成对发布；中途失败由 trap 撤销 archive。
if [ -e "$NAME" ] || [ -e "$NAME.sha256" ]; then
  printf '错误：目标文件在生成期间已出现（%s），为避免覆盖已中止\n' "$NAME" >&2
  exit 1
fi
mv -f "$PARTIAL" "$NAME"
PUBLISHED_ARCHIVE="$NAME"
mv -f "$CHECKSUM_PARTIAL" "$NAME.sha256"
CHECKSUM_PARTIAL=""
PUBLISHED_ARCHIVE=""
SIZE="$(wc -c < "$NAME" | tr -d ' ')"
printf '== 备份完成 ==\n'
printf '  文件：%s/%s\n' "$BACKUP_DIR" "$NAME"
printf '  整体 checksum：%s/%s.sha256\n' "$BACKUP_DIR" "$NAME"
printf '  内置清单：manifest.json + checksums.sha256（缺一不可）\n'
printf '  大小：%s 字节\n\n' "$SIZE"

# ------------------------------ 保留策略 ------------------------------------
# 默认绝不删除任何已有备份；只有 --prune 与 --yes 同时具备时才进入清理分支。
shopt -s nullglob
BACKUP_FILES=()
for cand in dev-*.tar; do
  # 只有 archive + 整体 checksum 同时存在的完整 bundle 才参与保留策略。
  # 旧版 dev-*.db 与孤立半成品永不自动删除。
  if [ -f "$cand" ] && [ ! -L "$cand" ] && [ -s "$cand" ] && \
     [ -f "$cand.sha256" ] && [ ! -L "$cand.sha256" ] && [ -s "$cand.sha256" ]; then
    BACKUP_FILES[${#BACKUP_FILES[@]}]="$cand"
  else
    printf '警告：跳过不完整/非普通 bundle，未计入份数且不会删除：%s/%s\n' "$BACKUP_DIR" "$cand" >&2
  fi
done
shopt -u nullglob
TOTAL="${#BACKUP_FILES[@]}"

# 按「时间戳 + 同秒序号」真实生成顺序排序后再取最旧的一批。
# 不能直接用 glob 字典序：ASCII '-'(0x2D) < '.'(0x2E)，同秒较新的
# dev-<STAMP>-2.tar 会排到 dev-<STAMP>.tar 之前，被误当成最旧而优先删除。
# 用 awk 拆出「时间戳<TAB>序号<TAB>文件名」三列，再 sort -k1,1 -k2,2n：
# 无后缀视为序号 0，dev-YYYYMMDD-HHMMSS-N.tar 视为序号 N（N>=2）。
# 不依赖 mtime（哨兵文件可能有相同 mtime）；C locale 保证字节序确定。
if [ "$TOTAL" -gt 0 ]; then
  SORTED_FILES=()
  while IFS=$'\t' read -r sort_ts sort_seq sort_file; do
    SORTED_FILES[${#SORTED_FILES[@]}]="$sort_file"
  done < <(
    for f in "${BACKUP_FILES[@]}"; do
      printf '%s\n' "$f"
    done | awk '
      BEGIN { OFS = "\t" }
      {
        name = $0
        body = name
        sub(/^dev-/, "", body)
        sub(/\.tar$/, "", body)
        ts = body
        seq = 0
        if (body ~ /^[0-9]+-[0-9]+-[0-9]+$/) {
          n = split(body, part, "-")
          seq = part[n] + 0
          ts = part[1] "-" part[2]
        }
        print ts, seq, name
      }
    ' | LC_ALL=C sort -k1,1 -k2,2n
  )
  BACKUP_FILES=("${SORTED_FILES[@]}")
fi

if [ "$TOTAL" -gt "$KEEP" ]; then
  EXCESS=$((TOTAL - KEEP))
  printf '当前 %s 份，超出保留上限 %s 份，可清理的旧文件如下：\n' "$TOTAL" "$KEEP"
  I=0
  while [ "$I" -lt "$EXCESS" ]; do
    printf '  %s/%s\n' "$BACKUP_DIR" "${BACKUP_FILES[$I]}"
    I=$((I + 1))
  done
  printf '（共 %s 份，按时间戳+同秒序号归一化时序取最旧的一批；以上即为完整待删清单）\n\n' "$EXCESS"

  if [ "$PRUNE_FLAG" -eq 1 ] && [ "$YES_FLAG" -eq 1 ]; then
    printf '已同时收到 --prune --yes，开始按上述清单逐文件清理：\n'
    I=0
    DELETED=0
    while [ "$I" -lt "$EXCESS" ]; do
      F="${BACKUP_FILES[$I]}"
      # 约束：当前备份目录内、普通文件、文件名匹配 dev-*.tar；checksum 成对删除。
      case "$F" in
        */*)
          printf '  跳过（路径越界）：%s\n' "$F" >&2
          ;;
        dev-*.tar)
          if [ -f "$F" ] && [ ! -L "$F" ] && [ -f "$F.sha256" ] && [ ! -L "$F.sha256" ]; then
            printf '  删除：%s/%s 与 %s/%s.sha256\n' "$BACKUP_DIR" "$F" "$BACKUP_DIR" "$F"
            rm -f "$F" "$F.sha256"
            DELETED=$((DELETED + 1))
          fi
          ;;
        *)
          printf '  跳过（文件名不匹配）：%s\n' "$F" >&2
          ;;
      esac
      I=$((I + 1))
    done
    printf '清理完成：共删除 %s 份。\n' "$DELETED"
  else
    printf '未执行删除。默认策略绝不删除任何已有备份；如需清理，请显式同时传入 --prune --yes。\n'
  fi
else
  printf '当前 %s 份，未超出保留上限 %s 份，无旧备份需要清理。\n' "$TOTAL" "$KEEP"
fi

exit 0
