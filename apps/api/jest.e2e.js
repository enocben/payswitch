module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  testMatch: ["<rootDir>/e2e/**/*.e2e-spec.ts"],
  transform: { "^.+\\.tsx?$": ["ts-jest", { isolatedModules: true }] },
  moduleNameMapper: {
    "^@payswitch/core$": "<rootDir>/../../packages/core/src/index.ts",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  testTimeout: 60000,
};
