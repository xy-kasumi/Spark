// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later

export type SegmentType = "remove-work" | "remove-tool" | "move-in" | "move-out" | "move";

export type PathSegment = {
    type: SegmentType;
    axisValues: {
        x: number;
        y: number;
        z: number;
    };
};

export type PulseConditions = {
    work: string, // M-line
    grinder: string, // M-line
};

export const generateGcode = (path: PathSegment[], pulseConds: PulseConditions): string => {
    let prevType = null;
    let prevX = null;
    let prevY = null;
    let prevZ = null;

    const lines = [];

    // normal code
    lines.push("G53"); // machine coords
    lines.push("G28"); // home

    lines.push("G55"); // work coords
    lines.push(`G0 X0 Y0 Z60`);
    prevX = 0;
    prevY = 0;
    prevZ = 60;

    for (let i = 0; i < path.length; i++) {
        const pt = path[i];
        let gcode = [];
        if (pt.type === "remove-work") {
            if (prevType !== pt.type) {
                lines.push(pulseConds.work);
            }
            gcode.push("G1");
        } else if (pt.type === "remove-tool") {
            if (prevType !== pt.type) {
                lines.push(pulseConds.grinder);
            }
            gcode.push("G1");
        } else if (pt.type === "move-out" || pt.type === "move-in" || pt.type === "move") {
            gcode.push("G0");
        } else {
            console.error("unknown path segment type", pt.type);
        }
        prevType = pt.type;

        const vals = pt.axisValues;
        if (prevX !== vals.x) {
            gcode.push(`X${vals.x.toFixed(3)}`);
            prevX = vals.x;
        }
        if (prevY !== vals.y) {
            gcode.push(`Y${vals.y.toFixed(3)}`);
            prevY = vals.y;
        }
        if (prevZ !== vals.z) {
            gcode.push(`Z${vals.z.toFixed(3)}`);
            prevZ = vals.z;
        }

        if (gcode.length > 1) {
            lines.push(gcode.join(" "));
        }
    }

    lines.push(`; end`);
    lines.push(`G0 Z60`); // pull
    lines.push(`G53`); // machine coords

    //lines.push(`M103`);

    lines.push("");
    return lines.join("\n");
}
