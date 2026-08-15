/**
 * This panel's own copy. Deliberately small: everything ABOUT a plugin — its
 * title, its summary, every field label on its configuration form — is written
 * by that plugin, in its own manifest and its own schema descriptions. What is
 * left here is the chrome, which belongs to no plugin.
 *
 * That split is the point of the whole convention. A dictionary here that grew
 * an entry per plugin would be a dictionary somebody has to edit before a new
 * plugin can be seen, and this panel's promise is that nobody has to.
 * @module @omdsh-plugins/omdsh-plughub/client/locales
 */

/** Every key this panel's dictionaries carry. */
export type PlughubLocaleKey = keyof typeof en

/** English dictionary. */
export const en = {
  tab: 'OMDSH Plugins',

  catalogHeading: 'Available',
  catalogEmpty: 'No plugins were offered by the configured sources.',
  catalogEmptySearch: 'No plugin matches this search.',
  search: 'Search plugins',
  refresh: 'Refresh',
  loading: 'Loading…',
  error: 'The plugin hub could not be reached.',
  retry: 'Retry',

  install: 'Install',
  uninstall: 'Remove',
  update: 'Update',
  installing: 'Installing…',
  uninstalling: 'Removing…',
  updating: 'Updating…',
  installed: 'Installed',
  installFailed: 'Install failed',
  uninstallFailed: 'Removal failed',
  updateFailed: 'Update failed',
  showLog: 'Show output',
  hideLog: 'Hide output',

  updateAvailable: 'Version {version} is available; this profile has {installed}.',
  updateCurrent: 'Up to date.',
  updateLinked: 'Installed from a directory on this machine, so its files are already the source.',
  updateUnknown: 'This source publishes no version to compare against.',

  sourcesHeading: 'Catalog sources',
  sourcesHint: 'Local checkouts, a published manifest, a GitHub account.',
  sourcesUnavailable: 'This runtime exposes no settings provider, so the sources stay as the profile composed them.',
  configuredAbove: 'Configured under Catalog sources, above.',

  sourceLocal: 'local',
  sourceRegistry: 'registry',
  sourceGithub: 'github',
  sourceFailed: '{source} is unavailable: {error}',
  docs: 'Documentation',

  restartTitle: 'Restart to finish',
  restartBody: 'The profile changed. Plugin layers are composed at boot, so restart dsh to load what changed.',

  installedHeading: 'Installed',
  installedEmpty: 'This profile has no removable plugins yet.',
  builtIn: 'built in',
  noSettings: 'This plugin declares nothing to configure.',
  readOnlyProvider: 'Settings are read-only in this deployment.',
  appliesRestart: 'restart to apply',
  overridden: 'changed',
  reset: 'Reset',
  resetTitle: 'Reset to the value this plugin was composed with',
  unsupportedField: 'This field is a {type}; edit it in the settings document.',
  secretSet: 'A value is stored. Type a new one to replace it.',
  secretUnset: 'No value stored.',
  addRow: 'Add',
  removeRow: 'Remove',
  keyPlaceholder: 'key',
  valuePlaceholder: 'value',
  writeFailed: 'Could not save: {error}',
  writeConflict: 'Somebody else changed this setting; the current value is shown.',
  profileLabel: 'Profile',
} as const

/** Chinese dictionary. */
export const zh: Record<PlughubLocaleKey, string> = {
  tab: 'OMDSH 插件',

  catalogHeading: '可安装',
  catalogEmpty: '配置的来源没有提供任何插件。',
  catalogEmptySearch: '没有匹配的插件。',
  search: '搜索插件',
  refresh: '刷新',
  loading: '加载中…',
  error: '无法连接插件中心。',
  retry: '重试',

  install: '安装',
  uninstall: '卸载',
  update: '更新',
  installing: '安装中…',
  uninstalling: '卸载中…',
  updating: '更新中…',
  installed: '已安装',
  installFailed: '安装失败',
  uninstallFailed: '卸载失败',
  updateFailed: '更新失败',
  showLog: '查看输出',
  hideLog: '收起输出',

  updateAvailable: '有新版本 {version}，当前为 {installed}。',
  updateCurrent: '已是最新。',
  updateLinked: '从本机目录链接安装，文件即为来源本身。',
  updateUnknown: '该来源没有提供可比较的版本号。',

  sourcesHeading: '目录来源',
  sourcesHint: '本地签出目录、已发布的清单、GitHub 账号。',
  sourcesUnavailable: '当前运行时没有设置服务，来源只能保持 profile 组装时的取值。',
  configuredAbove: '在上方的「目录来源」里配置。',

  sourceLocal: '本地',
  sourceRegistry: '清单',
  sourceGithub: 'GitHub',
  sourceFailed: '{source} 不可用：{error}',
  docs: '文档',

  restartTitle: '重启后生效',
  restartBody: 'profile 已改变。插件层在启动时组装，请重启 dsh 以加载变更。',

  installedHeading: '已安装',
  installedEmpty: '这个 profile 还没有可卸载的插件。',
  builtIn: '内置',
  noSettings: '这个插件没有声明可配置项。',
  readOnlyProvider: '当前部署的设置为只读。',
  appliesRestart: '重启后生效',
  overridden: '已修改',
  reset: '重置',
  resetTitle: '恢复为插件组装时的取值',
  unsupportedField: '该字段是 {type}，请到设置文件中修改。',
  secretSet: '已存有取值，输入新值可覆盖。',
  secretUnset: '尚未设置。',
  addRow: '添加',
  removeRow: '删除',
  keyPlaceholder: '键',
  valuePlaceholder: '值',
  writeFailed: '保存失败：{error}',
  writeConflict: '其他地方改动了这项设置，已显示当前取值。',
  profileLabel: 'Profile',
}
