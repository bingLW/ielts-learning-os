/**
 * 导入向导的草稿类型（步骤组件与容器共用，避免互相 import 形成运行时环）。
 */

import type { MaterialSourceType } from '@/lib/constants';

/** 第 1 步：来源方式。 */
export type ImportMode = 'file' | 'paste';

/** 第 2 步：来源与权限填报（全部保持字符串，提交前再转换类型）。 */
export interface SourceDraft {
  sourceType: MaterialSourceType;
  url: string;
  author: string;
  publisher: string;
  publishedYear: string;
  licenseName: string;
  licenseUrl: string;
  userNote: string;
  /** 第 3 步的勾选（禁止预设，A-01）。 */
  rightsConfirmed: boolean;
}

/** 向导整体草稿。 */
export interface ImportDraft {
  mode: ImportMode;
  file: File | null;
  pastedText: string;
  title: string;
  source: SourceDraft;
}

export const EMPTY_SOURCE_DRAFT: SourceDraft = {
  sourceType: 'user_upload',
  url: '',
  author: '',
  publisher: '',
  publishedYear: '',
  licenseName: '',
  licenseUrl: '',
  userNote: '',
  rightsConfirmed: false,
};
