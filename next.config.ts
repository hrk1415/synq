import type { NextConfig } from 'next';
import { loadStagingEnv } from './src/lib/staging-env';

if (process.env.SYNQ_ENV === 'staging') {
  loadStagingEnv(process.cwd());
}

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
