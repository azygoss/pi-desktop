import { registerRootComponent } from 'expo';

import App from './App';
import { registerKeepAliveTask } from './src/lib/background';

// The keep-alive service's task has to exist before the service can start it.
registerKeepAliveTask();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
