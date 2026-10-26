// Re-export the native module. On web, it will be resolved to ScreenTimeModule.web.ts
// and on native platforms to ScreenTimeModule.ts
export { default } from './src/ScreenTimeModule';
export * from './src/ScreenTimeModule.types';
