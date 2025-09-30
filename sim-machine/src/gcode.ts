import * as THREE from 'three';

/**
 * Single line in G-code program. Can be empty or comment-only, but valid.
 */
export type GCodeLine = {
    origLine: string,
    block?: GCodeBlock,
}

/**
 * Single valid G-code block.
 */
export type GCodeBlock = {
    command: string, // "G1", "G38.3", "M11" etc.
    params: Record<string, number>, // e.g. {X: 12.3} for "G1 X12.3"
    flags: string[], // e.g. ["X"] for "G28 X"
};


/**
 * Parse g-code program text into lines.
 */
export const parseGCodeProgram = (gcodeText: string): { lines: GCodeLine[], errors: string[] } => {
    const lines = [];
    const errors = [];
    gcodeText.split("\n").forEach((l, ix) => {
        const res = parseGCodeLine(l);
        if (typeof res === 'string') {
            errors.push(`line ${ix + 1}: ${res}`);
        } else {
            lines.push(res);
        }
    });
    return { lines, errors };
};


/**
 * Parse single line of G-code (+ comments). Can containt comment-only or empty lines.
 */
export const parseGCodeLine = (lineStr: string): GCodeLine | string => {
    const commentIdx = lineStr.indexOf(';');
    const blockStr = (commentIdx >= 0 ? lineStr.slice(0, commentIdx) : lineStr).trim();
    let block = undefined;
    if (blockStr.length > 0) {
        const res = parseGCodeBlock(blockStr);
        if (typeof res === 'string') {
            return `invalid block: ${res}`;
        }
        block = res;
    }
    return {
        origLine: lineStr,
        block: block,
    }
};

/**
 * Parse single block of G-code.
 * @param blockStr string like "G38.3 Z-5", "M4"
 * @returns parsed block or error string.
 */
export const parseGCodeBlock = (blockStr: string): GCodeBlock | string => {
    const words = blockStr.split(' ').map(w => w.trim()).filter(w => w.length > 0);
    if (words.length === 0) {
        return "missing command";
    }

    const command = words[0];
    if (!command.startsWith('G') && !command.startsWith('M')) {
        return `invalid command: ${command}`;
    }

    const params = {};
    const flags = [];
    for (const paramWord of words.slice(1)) {
        if (paramWord.length === 1) {
            const axis = paramWord[0];
            if (flags.includes(axis) || params[axis] !== undefined) {
                return `duplicate flag: ${axis}`;
            }
            flags.push(axis);
        } else {
            const axis = paramWord[0];
            const numStr = paramWord.slice(1);
            const val = parseFloat(numStr);
            if (isNaN(val) || !isFinite(val)) {
                return `invalid value in word ${paramWord}: ${numStr}`;
            }
            if (flags.includes(axis) || params[axis] !== undefined) {
                return `duplicate axis: ${axis}`;
            }
            params[axis] = val;
        }
    }
    return { command, params, flags };
};

/**
 * Entire path of g-code program.
 */
export type Path = {
    segments: PathSegment[],
    totalLen: number,
};

/**
 * Path segment in machine coordinate.
 */
export type PathSegment = {
    src: THREE.Vector3,
    dst: THREE.Vector3,
    srcDist: number, // distance from the beginning of the path.
    dstDist: number,
    segType: "G0" | "G1",
    coordSys: CoordSys, // original coordinate system of the g-code block.
};

export type CoordSys = "machine" | "grinder" | "work" | "toolsupply";

/**
 * Trace path from g-code blocks.
 * @param offsets: Offset of origin of each coordsys in machine coordsys. (thus machine is always (0,0,0))
 */
export const tracePath = (blocks: GCodeBlock[], offsets: Record<CoordSys, THREE.Vector3>): Path => {
    const sysTable: Record<string, CoordSys> = {
        "G53": "machine",
        "G54": "grinder",
        "G55": "work",
        "G56": "toolsupply"
    };

    const transformToSys = (pt: THREE.Vector3, targSys: CoordSys): THREE.Vector3 => {
        return pt.sub(offsets[targSys]);
    };
    const transformFromSys = (pt: THREE.Vector3, srcSys: CoordSys): THREE.Vector3 => {
        return pt.add(offsets[srcSys]);
    };

    // Update pt in-place by the move with params.
    const moveByParams = (pt: THREE.Vector3, params: Record<string, number>): THREE.Vector3 => {
        if (params["X"] !== undefined) {
            pt.x = params["X"];
        }
        if (params["Y"] !== undefined) {
            pt.y = params["Y"];
        }
        if (params["Z"] !== undefined) {
            pt.z = params["Z"];
        }
        return pt;
    };

    const segments: PathSegment[] = [];
    let currSys: CoordSys = "machine";
    let curr = new THREE.Vector3();
    let currDist = 0;

    for (const block of blocks) {
        if (block.command === "G0" || block.command === "G1") {
            const next = moveByParams(curr.clone(), block.params);
            const segLen = next.distanceTo(curr);
            const nextDist = currDist + segLen;

            segments.push({
                src: transformFromSys(curr.clone(), currSys),
                dst: transformFromSys(next.clone(), currSys),
                srcDist: currDist,
                dstDist: nextDist,
                segType: block.command,
                coordSys: currSys,
            });

            curr = next;
            currDist = nextDist;
        } else if (sysTable[block.command] !== undefined) {
            const currInMachine = transformFromSys(curr.clone(), currSys);
            currSys = sysTable[block.command];
            curr = transformToSys(currInMachine, currSys);
        }
    }

    return {
        segments,
        totalLen: currDist,
    };
};
