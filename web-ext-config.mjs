/**
 * web-ext 配置(web-ext lint / build / run 会自动读取)。
 *
 * 仓库里的测试、依赖与文档不需要打进扩展包。注意 ignoreFiles 同时作用于
 * lint 与 build,所以这里的列表要覆盖所有非运行时文件。
 */
export default {
  ignoreFiles: [
    "package.json",
    "package-lock.json",
    "web-ext-config.mjs",
    "test/**",
    "node_modules/**",
    ".idea/**",
    ".playwright-mcp/**",
    ".gitignore",
    "README.md",
    "README_EN.md",
  ],
};
