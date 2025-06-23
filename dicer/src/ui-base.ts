// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from 'three';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

const fontLoader = new FontLoader();
let font = null;

export const loadFont = async (): Promise<void> => {
    return new Promise<void>((resolve) => {
        fontLoader.load("../assets/fonts/Source Sans 3_Regular.json", (f) => {
            font = f;
            resolve();
        });
    });
};

export const debug = {
    vlog: ((o: any): void => { throw new Error("not initialized yet"); }),
    vlogE: ((o: any): void => { throw new Error("not initialized yet"); }),
    strict: false, // should raise exception at logic boundary even when it can continue.
    log: true, // emit vlogs (this is useful, because currently vlogs are somewhat slow)
    dotGeomCache: null as any,
};

// orange-teal-purple color palette for ABC axes.
export const axisColorA = new THREE.Color(0xe67e22);
export const axisColorB = new THREE.Color(0x1abc9c);
export const axisColorC = new THREE.Color(0x9b59b6);

/**
 * @param p Start point
 * @param n Direction vector
 * @param r Radius
 * @param col Color
 */
export const visCylinder = (p: THREE.Vector3, n: THREE.Vector3, r: number, col: THREE.Color | string): THREE.Mesh => {
    // Cylinder lies along Y axis, centered at origin.
    const geom = new THREE.CylinderGeometry(r, r, 30, 8);
    const mat = new THREE.MeshBasicMaterial({ color: col, wireframe: true });
    const mesh = new THREE.Mesh(geom, mat);

    const rotV = new THREE.Vector3(0, 1, 0).cross(n);
    if (rotV.length() > 1e-6) {
        mesh.setRotationFromAxisAngle(rotV.clone().normalize(), Math.asin(rotV.length()));
    }
    mesh.position.copy(n.clone().multiplyScalar(15).add(p));
    return mesh;
};

/**
 * Quick visualization of a point.
 * 
 * @param p Location in work coords
 * @param col Color
 */
export const visDot = (p: THREE.Vector3, col: THREE.Color | string): THREE.Mesh => {
    if (!debug.dotGeomCache) {
        debug.dotGeomCache = new THREE.SphereGeometry(0.1);
    }
    const sphMat = new THREE.MeshBasicMaterial({ color: col });
    const sph = new THREE.Mesh(debug.dotGeomCache, sphMat);
    sph.position.copy(p);
    return sph;
}

/**
 * Quick visualization of a quad. {p, p+a, p+b, p+a+b} as wireframe.
 * 
 * @param p Origin
 * @param a First edge vector
 * @param b Second edge vector
 * @param color Color
 */
export const visQuad = (p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, color: THREE.Color | string): THREE.Mesh => {
    const geom = new THREE.BufferGeometry();
    const pos = new Float32Array([
        p.x, p.y, p.z,
        p.x + a.x, p.y + a.y, p.z + a.z,
        p.x + a.x + b.x, p.y + a.y + b.y, p.z + a.z + b.z,
        p.x + b.x, p.y + b.y, p.z + b.z,
    ]);
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));

    return new THREE.LineLoop(geom, new THREE.LineBasicMaterial({ color }));
};

/**
 * @param p Location in work coords
 * @param text Text to display
 * @param size Text size
 * @param color Text color
 */
export const visText = (p: THREE.Vector3, text: string, size: number = 0.25, color: string = "#222222"): THREE.Mesh => {
    const textGeom = new TextGeometry(text, {
        font,
        size,
        depth: 0.1,
    });
    const textMesh = new THREE.Mesh(textGeom, new THREE.MeshBasicMaterial({ color }));
    textMesh.position.copy(p);
    return textMesh;
};


