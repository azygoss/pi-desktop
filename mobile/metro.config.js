const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')
const { writeIconBarrel } = require('./scripts/icon-barrel')

const config = getDefaultConfig(__dirname)

// The app renders chats with the desktop's own reducers and summaries
// (../src/shared, ../src/renderer/src/lib): watch them. The repo's own
// node_modules is not watched, so the packages those files import resolve
// from this app's node_modules and the desktop's are never bundled.
const repoRoot = path.resolve(__dirname, '..')
config.watchFolders = [path.join(repoRoot, 'src', 'shared'), path.join(repoRoot, 'src', 'renderer', 'src', 'lib')]
config.resolver.nodeModulesPaths = [path.join(__dirname, 'node_modules')]

// Only the icons the app uses reach the bundle (see scripts/icon-barrel.js).
const iconBarrel = writeIconBarrel(path.join(__dirname, '.generated', 'icons.js'))
const defaultResolve = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'lucide-react-native') {
    return { type: 'sourceFile', filePath: iconBarrel }
  }
  return (defaultResolve ?? context.resolveRequest)(context, moduleName, platform)
}

module.exports = config
