declare module "confusing-browser-globals" {
  const names: readonly string[];
  export default names;
}

declare module "eslint-plugin-jsx-a11y" {
  const plugin: import("eslint").ESLint.Plugin;
  export default plugin;
}
