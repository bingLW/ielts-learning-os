import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const developmentDatabase = join(process.cwd(), 'prisma', 'dev.db');

function checksum(): string | null {
  if (!existsSync(developmentDatabase)) return null;
  return createHash('sha256').update(readFileSync(developmentDatabase)).digest('hex');
}

export default function guardDevelopmentDatabase(): () => void {
  const before = checksum();
  return () => {
    const after = checksum();
    if (after !== before) {
      throw new Error('测试运行期间真实 prisma/dev.db 发生变化；请检查测试数据库隔离。');
    }
  };
}
