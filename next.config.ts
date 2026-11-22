import type { NextConfig } from 'next';

/**
 * Next.js 配置。
 *
 * 硬约束一：本项目是单进程单用户工作台，数据访问全部经由
 * Server Component / Server Action，不暴露 REST 层。
 *
 * 硬约束二（v2.6 ADR-01）：`pdfjs-dist` 只用于服务端提取 PDF 文本，
 * 必须留在 Node 运行时、不进客户端 bundle，也不能被 Next 的打包器改写。
 * 因此登记到 `serverExternalPackages`，由 Node 直接 `import()` 原始包。
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['pdfjs-dist'],
};

export default nextConfig;
