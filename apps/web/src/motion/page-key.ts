const rules: readonly (readonly [RegExp, string])[] = [
  [/^\/$/, 'home'],
  [/^\/welcome/, 'welcome'],
  [/^\/chat\//, 'chat'],
  [/^\/notes\/[^/]+$/, 'note'],
  [/^\/notes\/?$/, 'notes'],
  [/^\/todos\/edit\//, 'todo-editor'],
  [/^\/todos\/?$/, 'todos'],
  [/^\/review\//, 'review'],
  [/^\/pets\/lili/, 'lili'],
  [/^\/pets\/lumi/, 'lumi'],
  [/^\/pets\/draw/, 'draw'],
  [/^\/pets\/jobs\//, 'pet-job'],
  [/^\/pets/, 'pets'],
  [/^\/settings/, 'settings'],
  [/^\/onboarding\/login/, 'account'],
  [/^\/onboarding/, 'onboarding'],
  [/^\/sync\/conflicts/, 'conflicts'],
  [/^\/overlay\/guide/, 'guide'],
  [/^\/overlay\//, 'overlay'],
];

/** 把当前路由映射成模块键，写到 <main data-page> 上供样式与端到端测试共用。 */
export function pageKey(pathname: string): string {
  for (const [pattern, key] of rules) if (pattern.test(pathname)) return key;
  return 'unknown';
}
