/**
 * `/materials/import` 导入向导。
 *
 * 限额/来源文案/能力矩阵全部来自 `getMaterialImportContext()`（服务端），
 * 前端不硬编码任何数字，改常量即改文案。
 */

import { ImportWizard } from '@/components/materials/ImportWizard';
import { getMaterialImportContext } from '@/lib/queries/materials';

export const dynamic = 'force-dynamic';

export default async function MaterialImportPage() {
  const context = await getMaterialImportContext();
  return <ImportWizard context={context} />;
}
