// TypeScript 6 (TS2882) requires a type declaration for side-effect imports of
// non-code modules, such as `import '@/styles/globals.css'` in the root layout.
// CSS Modules (*.module.css) are typed by Next's own declarations; this only
// covers plain stylesheet side-effect imports.
declare module '*.css';
