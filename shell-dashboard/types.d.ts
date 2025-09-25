// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later

declare const Vue: {
    createApp: (options: any) => {
        mount: (selector: string) => void;
    };
};

declare const Chart: {
    new (context: string | HTMLCanvasElement | HTMLVideoElement | OffscreenCanvas, config: any): any;
};

declare function atob(encodedData: string): string;