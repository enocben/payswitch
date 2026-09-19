module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/**/*.spec.ts"],
  transform: { "^.+\\.tsx?$": ["ts-jest", { isolatedModules: true }] },
  moduleNameMapper: {
    "^@payswitch/core$": "<rootDir>/../../packages/core/src/index.ts",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
};
