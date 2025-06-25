#!/bin/bash

echo "Starting watch mode for spooler..."
echo "Watching: *.ts, *.html, *.css"
echo "Press Ctrl+C to stop"

# Initial build
./build.sh

# Watch for changes using a simple polling approach
# This avoids dependency on inotify-tools while still being functional
watch_files() {
    local last_mod_time=""
    
    while true; do
        # Get modification times of all watched files
        local current_mod_time=$(find . -maxdepth 1 \( -name "*.ts" -o -name "*.html" -o -name "*.css" \) -exec stat -c "%Y %n" {} \; 2>/dev/null | sort)
        
        if [[ "$current_mod_time" != "$last_mod_time" ]]; then
            if [[ -n "$last_mod_time" ]]; then
                echo ""
                echo "$(date): Files changed, rebuilding..."
                ./build.sh
                echo "$(date): Build complete. Watching for changes..."
            fi
            last_mod_time="$current_mod_time"
        fi
        
        sleep 1
    done
}

watch_files