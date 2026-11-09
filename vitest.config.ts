import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tres suites, alineadas con los checks obligatorios del CI:
//   unit        -> *.unit.test.ts         (sin red: logica de negocio y SAGA con dobles)
//   integration -> *.int.test.ts          (DynamoDB real en Floci + endpoints HTTP/GraphQL)
//   e2e         -> tests/e2e/*.e2e.test.ts (los 4 servicios levantados + flujo completo por GraphQL)
const alias = {
  '@aegisvolt/common': fileURLToPath(new URL('./packages/common/src/index.ts', import.meta.url)),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: 'unit', include: ['**/test/**/*.unit.test.ts'], exclude: ['**/node_modules/**'] },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['**/test/**/*.int.test.ts'],
          exclude: ['**/node_modules/**'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.e2e.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
