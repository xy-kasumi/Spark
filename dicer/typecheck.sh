#!/bin/bash
# Type check first-party JavaScript files with JSDoc annotations
# Avoids processing third-party dependencies by using --noResolve
tsc --noEmit --allowJs --checkJs --target ES2022 --lib ES2022,DOM --skipLibCheck --noResolve main.js mesh.js voxel.js "$@"