import type { NextConfig } from 'next';

/**
 * Next.js 配置。
 *
 * 只有一条硬约束在这里表达：本项目是单进程单用户工作台，
 * 数据访问全部经由 Server Component / Server Action，不暴露 REST 层。
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
