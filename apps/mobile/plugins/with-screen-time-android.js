const { withAppBuildGradle } = require('expo/config-plugins');

const BEGIN = '// @generated begin sumore-android-desugaring';
const END = '// @generated end sumore-android-desugaring';
const DEPENDENCY = 'com.android.tools:desugar_jdk_libs:2.1.5';

function withDesugaring(contents) {
  if (!/\bandroid\s*\{/.test(contents)) {
    throw new Error('sumore app limits could not find the Android Gradle configuration.');
  }
  // App and library both need desugaring for java.time on API24/25. A final
  // separate DSL block preserves Expo's Java/Kotlin compatibility settings and
  // avoids brittle edits to nested android/defaultConfig/compileOptions braces.
  const withoutPrevious = contents.replace(
    /\n?\/\/ @generated begin sumore-android-desugaring\r?\n[\s\S]*?\/\/ @generated end sumore-android-desugaring\r?\n?/g,
    '',
  ).trimEnd();
  const hasDependency = /\bcoreLibraryDesugaring\s*(?:\(\s*)?['"]com\.android\.tools:desugar_jdk_libs:2\.1\.5['"]/.test(withoutPrevious);
  return `${withoutPrevious}\n\n${BEGIN}\nandroid {\n    compileOptions {\n        coreLibraryDesugaringEnabled true\n    }\n}\n${hasDependency ? '' : `dependencies {\n    coreLibraryDesugaring '${DEPENDENCY}'\n}\n`}${END}\n`;
}

function withScreenTimeAndroid(config) {
  return withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy') {
      throw new Error('sumore app limits currently require Expo\'s Groovy Android app/build.gradle.');
    }
    mod.modResults.contents = withDesugaring(mod.modResults.contents);
    return mod;
  });
}

module.exports = withScreenTimeAndroid;
module.exports.withDesugaring = withDesugaring;
