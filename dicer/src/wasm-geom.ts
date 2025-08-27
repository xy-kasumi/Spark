// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from 'three';

export class WasmGeom {
    module: any; // imported WASM module

    constructor(module: any) {
        this.module = module;
    }

    /**
     * Project mesh geometry to 2D contours using WASM
     * @param geometry - Input geometry to project
     * @param origin - 3D origin point for projection plane
     * @param viewX - X axis of projection coordinate system (must be orthonormal)
     * @param viewY - Y axis of projection coordinate system (must be orthonormal)
     * @param viewZ - Z axis of projection coordinate system (viewing direction, must be orthonormal)
     * @returns Array of contours (each contour is an array of 2D points)
     */
    projectMesh(
        geometry: THREE.BufferGeometry,
        origin: THREE.Vector3,
        viewX: THREE.Vector3,
        viewY: THREE.Vector3,
        viewZ: THREE.Vector3
    ): THREE.Vector2[][] {
        const triangleSoup = toTriSoup(geometry);

        const Module = this.module;
        const numVertices = triangleSoup.length / 3;

        // Allocate and populate triangle_soup struct
        const soupPtr = Module._malloc(16); // Allocate extra for alignment
        const verticesPtr = Module._malloc(triangleSoup.length * 4); // triangleSoup.length floats * 4 bytes each
        Module.HEAPF32.set(triangleSoup, verticesPtr / 4);
        Module.HEAP32[soupPtr / 4] = numVertices; // Set num_vertices
        Module.HEAP32[soupPtr / 4 + 1] = verticesPtr; // Set vertices pointer

        // Allocate and populate view parameters
        const originPtr = Module._malloc(12);
        const viewXPtr = Module._malloc(12);
        const viewYPtr = Module._malloc(12);
        const viewZPtr = Module._malloc(12);
        Module.HEAPF32.set([origin.x, origin.y, origin.z], originPtr / 4);
        Module.HEAPF32.set([viewX.x, viewX.y, viewX.z], viewXPtr / 4);
        Module.HEAPF32.set([viewY.x, viewY.y, viewY.z], viewYPtr / 4);
        Module.HEAPF32.set([viewZ.x, viewZ.y, viewZ.z], viewZPtr / 4);

        try {
            // Call WASM function
            const resultPtr = Module._project_mesh(soupPtr, originPtr, viewXPtr, viewYPtr, viewZPtr);
            if (!resultPtr) throw new Error("project_mesh returned null");

            // Read result
            const numContours = Module.getValue(resultPtr, 'i32');
            const contoursPtr = Module.getValue(resultPtr + 4, 'i32');
            const errorMsgPtr = Module.getValue(resultPtr + 8, 'i32');

            // Check for error
            if (errorMsgPtr !== 0) {
                const errorMsg = Module.UTF8ToString(errorMsgPtr);
                throw new Error(errorMsg);
            }

            // Convert contours to TypeScript objects
            const contours: THREE.Vector2[][] = [];
            for (let i = 0; i < numContours; i++) {
                const contourPtr = contoursPtr + i * 8; // Each contour_2d is 8 bytes (int + pointer)
                const numPoints = Module.getValue(contourPtr, 'i32');
                const pointsPtr = Module.getValue(contourPtr + 4, 'i32');

                const contour: THREE.Vector2[] = [];
                for (let j = 0; j < numPoints; j++) {
                    const pointPtr = pointsPtr + j * 8; // Each vector2 is 8 bytes (2 floats)
                    const x = Module.HEAPF32[pointPtr / 4];
                    const y = Module.HEAPF32[pointPtr / 4 + 1];
                    contour.push(new THREE.Vector2(x, y));
                }
                contours.push(contour);
            }

            // Clean up result
            Module._free_contours(resultPtr);
            return contours;

        } finally {
            // Always clean up input memory
            Module._free(soupPtr);
            Module._free(verticesPtr);
            Module._free(originPtr);
            Module._free(viewXPtr);
            Module._free(viewYPtr);
            Module._free(viewZPtr);
        }
    }

    /**
     * Subtract one mesh from another using WASM Manifold
     * @param geometryA - First geometry (minuend)
     * @param geometryB - Second geometry to subtract from first (subtrahend)
     * @returns Resulting geometry (A - B)
     */
    subtractMesh(
        geometryA: THREE.BufferGeometry,
        geometryB: THREE.BufferGeometry
    ): THREE.BufferGeometry {
        const Module = this.module;
        const meshA = toTriSoup(geometryA);
        const meshB = toTriSoup(geometryB);

        // Allocate triangle_soup structs for both inputs
        const soupAPtr = Module._malloc(8); // num_vertices (int) + vertices pointer
        const soupBPtr = Module._malloc(8);

        // Allocate vertex data for mesh A
        const numVertsA = meshA.length / 3;
        const verticesAPtr = Module._malloc(numVertsA * 12); // 3 floats * 4 bytes per vertex
        for (let i = 0; i < numVertsA; i++) {
            Module.HEAPF32[(verticesAPtr / 4) + i * 3] = meshA[i * 3];
            Module.HEAPF32[(verticesAPtr / 4) + i * 3 + 1] = meshA[i * 3 + 1];
            Module.HEAPF32[(verticesAPtr / 4) + i * 3 + 2] = meshA[i * 3 + 2];
        }
        Module.HEAP32[soupAPtr / 4] = numVertsA;
        Module.HEAP32[(soupAPtr / 4) + 1] = verticesAPtr;

        // Allocate vertex data for mesh B
        const numVertsB = meshB.length / 3;
        const verticesBPtr = Module._malloc(numVertsB * 12);
        for (let i = 0; i < numVertsB; i++) {
            Module.HEAPF32[(verticesBPtr / 4) + i * 3] = meshB[i * 3];
            Module.HEAPF32[(verticesBPtr / 4) + i * 3 + 1] = meshB[i * 3 + 1];
            Module.HEAPF32[(verticesBPtr / 4) + i * 3 + 2] = meshB[i * 3 + 2];
        }
        Module.HEAP32[soupBPtr / 4] = numVertsB;
        Module.HEAP32[(soupBPtr / 4) + 1] = verticesBPtr;

        try {
            // Call WASM Manifold subtraction function
            const resultPtr = Module._manifold_subtract_meshes(soupAPtr, soupBPtr);
            if (!resultPtr) throw new Error("manifold_subtract_meshes returned null");

            // Read result
            const numResultVerts = Module.getValue(resultPtr, 'i32');
            const resultVerticesPtr = Module.getValue(resultPtr + 4, 'i32');
            const errorMsgPtr = Module.getValue(resultPtr + 8, 'i32');

            // Check for error
            if (errorMsgPtr !== 0) {
                const errorMsg = Module.UTF8ToString(errorMsgPtr);
                throw new Error(errorMsg);
            }

            // Copy result vertices
            const result = new Float64Array(numResultVerts * 3);
            for (let i = 0; i < numResultVerts * 3; i++) {
                result[i] = Module.HEAPF32[(resultVerticesPtr / 4) + i];
            }

            // Clean up result
            Module._free_triangle_soup_result(resultPtr);

            return fromTriSoup(result);
        } finally {
            // Always clean up input memory
            Module._free(soupAPtr);
            Module._free(soupBPtr);
            Module._free(verticesAPtr);
            Module._free(verticesBPtr);
        }
    }
}

export async function initWasmGeom(): Promise<WasmGeom> {
    // @ts-ignore - WASM module will be generated at build time
    const WasmGeomModule = (await import('./wasm/wasm_geom.js')).default;

    let moduleInstance: any = null;
    moduleInstance = await WasmGeomModule({
        env: {
            wasmLog: function (msgPtr: number) {
                const msg = moduleInstance.UTF8ToString(msgPtr);
                wasmLog(msg);
            },
            wasmBeginPerf: function (tagPtr: number) {
                const tag = moduleInstance.UTF8ToString(tagPtr);
                wasmBeginPerf(tag);
            },
            wasmEndPerf: function (tagPtr: number) {
                const tag = moduleInstance.UTF8ToString(tagPtr);
                wasmEndPerf(tag);
            }
        }
    });
    return new WasmGeom(moduleInstance);
}

const perfMap = new Map<string, number>();

function wasmLog(msg: string) {
    console.log(msg);
}

function wasmBeginPerf(tag: string) {
    perfMap.set(tag, performance.now());
}

function wasmEndPerf(tag: string) {
    const startTime = perfMap.get(tag);
    if (startTime !== undefined) {
        const endTime = performance.now();
        const duration = endTime - startTime;
        console.log(`[${tag}] ${duration.toFixed(2)}ms`);
        perfMap.delete(tag);
    } else {
        console.warn(`[${tag}] No matching beginPerf found`);
    }
}

/**
 * Convert BufferGeometry to "triangle soup" representation
 * @param geom Input geometry
 * @returns Triangle soup array
 */
export function toTriSoup(geom: THREE.BufferGeometry): Float64Array {
    if (geom.index === null) {
        console.log("toTriSoup: converting from non-indexed geometry");
        const posArray = geom.getAttribute("position").array;
        return new Float64Array(posArray);
    } else {
        console.log("toTriSoup: converting from indexed geometry");
        const ix = geom.index.array;
        const pos = geom.getAttribute("position").array;

        const numTris = ix.length / 3;
        const buf = new Float64Array(numTris * 9);
        for (let i = 0; i < numTris; i++) {
            for (let v = 0; v < 3; v++) {
                const vIx = ix[3 * i + v];
                buf[9 * i + 3 * v + 0] = pos[3 * vIx + 0];
                buf[9 * i + 3 * v + 1] = pos[3 * vIx + 1];
                buf[9 * i + 3 * v + 2] = pos[3 * vIx + 2];
            }
        }
        return buf;
    }
}

/**
 * Convert triangle soup to BufferGeometry.
 * @param triSoup Triangle soup array
 */
function fromTriSoup(triSoup: Float64Array): THREE.BufferGeometry {
    const positions = new Float32Array(triSoup.length);
    for (let i = 0; i < triSoup.length; i++) {
        positions[i] = triSoup[i];
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    return geometry;
}
