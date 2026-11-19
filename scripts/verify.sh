#!/bin/bash
# IELTS Learning OS - 一键初始化与验证
# 用法：bash scripts/verify.sh
# 说明：本机 WorkBuddy 沙箱无法执行 shell（sandbox-exec 数据超限），因此首次构建需要在这里手动跑一次。

set -o pipefail
cd "$(dirname "$0")/.." || exit 1
echo "== 工作目录: $(pwd)"

echo ""
echo "== [1/9] 对齐依赖（package.json 已钉 @prisma/client 与 prisma 均为 6.16.2）"
# 不要用 `npm i @prisma/client@6`：那会把 package.json 里的精确版本 6.16.2 改成 ^6.x 范围。
# `npm i` 会按 package.json 纠正 node_modules 里残留的 7.x。
npm i 2>&1 | tail -3
npx prisma -v 2>&1 | head -3
echo "   ↑ 必须显示 prisma 6.16.2；若仍是 7.x，再执行：npm i @prisma/client@6.16.2 -D prisma@6.16.2"

echo ""
echo "== [2/9] 生成 Prisma Client"
npx prisma generate 2>&1 | tail -8

echo ""
echo "== [3/9] 建库（SQLite）"
npx prisma db push --skip-generate 2>&1 | tail -8

echo ""
echo "== [4/9] 灌入种子数据（4 阶段 / 28 条验收项 / 8 类资源）"
npx tsx prisma/seed.ts 2>&1 | tail -15

echo ""
echo "== [5/9] 类型检查（错误最多的一步，失败请把 error TS 行贴回来）"
npx tsc --noEmit 2>&1 | tail -40

echo ""
echo "== [6/9] 测试文件类型检查（根 tsconfig 排除了 __tests__，这里单独查）"
npx tsc -p tsconfig.test.json --noEmit 2>&1 | tail -20

echo ""
echo "== [7/9] 单元测试（领域纯函数）"
npm test 2>&1 | tail -30

echo ""
echo "== [8/9] 生产构建（若报 EPERM: unlink，属宿主文件策略，用 README §10 的容器命令）"
npm run build 2>&1 | tail -40

echo ""
echo "== [9/9] 完成"
echo "启动开发服务器：npm run dev  →  http://localhost:3000"
