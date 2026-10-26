import { NativeModule, registerWebModule } from 'expo';

// ScreenTimeModule is not available on the web platform.
class ScreenTimeModule extends NativeModule {}

export default registerWebModule(ScreenTimeModule, 'ScreenTimeModule');
