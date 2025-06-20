#!/bin/bash
# Type check first-party JavaScript files with JSDoc annotations
# Uses paths mapping to redirect third-party imports to fake declarations
tsc --project tsconfig.typecheck.json "$@"