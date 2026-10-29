/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // ESLint is validated separately via root `pnpm lint`
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
