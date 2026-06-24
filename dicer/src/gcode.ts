// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later

export type SegmentType = "remove-work" | "move-in" | "move-out" | "move";

/**
 * Pulse condition (e.g. "M3 P150 Q20 R50"), as a single G-code line.
 * Use {@link asPulseCondition} to construct one.
 */
export type PulseCondition = string & { readonly __pulseCondition: unique symbol };

export const asPulseCondition = (s: string): PulseCondition => s as PulseCondition;

export type PathSegment = {
    type: SegmentType,
    axisValues: {
        x: number;
        y: number;
        z: number;
    },
    /// Only available iff type === "remove-work".
    workPulse: PulseCondition | null,
};

export const generateGcode = (path: PathSegment[]): string => {
    let prevType = null;
    let prevX = null;
    let prevY = null;
    let prevZ = null;
    let prevPulse = null;

    const lines = [];

    // normal code
    lines.push("G53"); // machine coords
    lines.push("G28"); // home

    lines.push("G55"); // work coords
    lines.push(`G0 X0 Y0 Z60`);
    lines.push(`G0 X-12`);
    lines.push(`G29 W20 D25`); // calibrate

    prevX = 0;
    prevY = 0;
    prevZ = 60;

    for (let i = 0; i < path.length; i++) {
        const pt = path[i];
        let gcode = [];
        if (pt.type === "remove-work") {
            if (prevType !== pt.type && prevPulse !== pt.workPulse) {
                lines.push(pt.workPulse);
                prevPulse = pt.workPulse;
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
