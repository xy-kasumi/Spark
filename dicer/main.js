import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// TODO: Refactor
let objSurf = null;



// voxel at (ix, iy, iz):
// * occupies volume: [ofs + i * res, ofs + (i + 1) * res)
// * has center: ofs + (i + 0.5) * res
class VoxelGrid {
    constructor(ofs, res, numX, numY, numZ) {
        this.ofs = ofs;
        this.res = res;
        this.numX = numX;
        this.numY = numY;
        this.numZ = numZ;
        this.data = new Uint8Array(numX * numY * numZ);
    }

    clone() {
        const vg = new VoxelGrid(this.ofs.clone(), this.res, this.numX, this.numY, this.numZ);
        vg.data.set(this.data);
        return vg;
    }

    sub(other) {
        for (let i = 0; i < this.data.length; i++) {
            this.data[i] = Math.max(0, this.data[i] - other.data[i]);
        }
        return this;
    }

    add(other) {
        for (let i = 0; i < this.data.length; i++) {
            this.data[i] = Math.min(255, this.data[i] + other.data[i]);
        }
        return this;
    }

    multiplyScalar(s) {
        for (let i = 0; i < this.data.length; i++) {
            this.data[i] = Math.round(this.data[i] * s);
        }
        return this;
    }

    set(ix, iy, iz, val) {
        this.data[ix + iy * this.numX + iz * this.numX * this.numY] = val;
    }

    get(ix, iy, iz) {
        return this.data[ix + iy * this.numX + iz * this.numX * this.numY];
    }

    count() {
        let cnt = 0;
        for (let i = 0; i < this.data.length; i++) {
            if (this.data[i] !== 0) {
                cnt++;
            }
        }
        return cnt;
    }

    volume() {
        return this.count() * this.res * this.res * this.res;
    }
}


const convGeomToSurf = (geom) => {
    if (geom.index === null) {
        return geom.getAttribute("position").array;
    } else {
        const ix = geom.index.array;
        const pos = geom.getAttribute("position").array;

        const numTris = ix.length / 3;
        const buf = new Float32Array(numTris * 9);
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
};

// surf: tri vertex list
const diceAndVisualize = (blankSurf, objSurf, resMm) => {
    // cleanup prev vis
    if (view.visVg) {
        scene.remove(view.visVg);
    }
    view.visVg = null;

    const vgBlank = initVG(blankSurf, resMm);
    const vgObj = vgBlank.clone();

    diceSurf(blankSurf, vgBlank);
    diceSurf(objSurf, vgObj);
    const diff = vgBlank.clone().sub(vgObj);
    console.log(`removal: ${diff.volume()}mm^3 (${diff.count()} voxels)`,);

    vgBlank.multiplyScalar(0.1);
    vgBlank.add(vgObj);

    view.visVg = createVgVis(vgBlank);
    dicer.showVoxels = true;
    view.scene.add(view.visVg);
};

const diceLineAndVisualize = (surf, lineY, lineZ) => {
    // cleanup prev vis
    view.visNonVg.forEach(v => view.scene.remove(v));
    view.visNonVg = [];

    // slice specific (Y, Z) line.
    const cont = sliceSurfByPlane(surf, lineZ);
    const bnds = sliceContourByLine(cont, lineY);

    // visualize
    const visContour = createContourVis(cont);
    view.scene.add(visContour);
    visContour.position.z = lineZ;
    view.visNonVg.push(visContour);

    const visBnd = createBndsVis(bnds);
    view.scene.add(visBnd);
    visBnd.position.y = lineY;
    visBnd.position.z = lineZ;
    view.visNonVg.push(visBnd);
};

const isectLine = (p, q, z) => {
    const d = q.z - p.z;
    const t = (d === 0) ? 0.5 : (z - p.z) / d;
    return p.clone().lerp(q, t);
};

const isectLine2 = (p, q, y) => {
    const d = q.y - p.y;
    const t = (d === 0) ? 0.5 : (y - p.y) / d;
    return p.clone().lerp(q, t);
};


const initVG = (surf, resMm) => {
    const MARGIN_MM = 1;

    // compute AABB
    const aabbMin = new THREE.Vector3(surf[0], surf[1], surf[2]);
    const aabbMax = new THREE.Vector3(surf[0], surf[1], surf[2]);
    for (let i = 1; i < surf.length / 3; i++) {
        const v = new THREE.Vector3(surf[3 * i + 0], surf[3 * i + 1], surf[3 * i + 2]);
        aabbMin.min(v);
        aabbMax.max(v);
    }
    console.log("AABB", aabbMin, aabbMax);

    aabbMin.subScalar(MARGIN_MM);
    aabbMax.addScalar(MARGIN_MM);
    const numV = aabbMax.clone().sub(aabbMin).divideScalar(resMm).ceil();
    console.log("VG size", numV);
    return new VoxelGrid(aabbMin, resMm, numV.x, numV.y, numV.z);
};

const diceSurf = (surf, vg) => {
    console.log("dicing...");
    for (let iz = 0; iz < vg.numZ; iz++) {
        const sliceZ = vg.ofs.z + (iz + 0.5) * vg.res;
        const cont = sliceSurfByPlane(surf, sliceZ);

        for (let iy = 0; iy < vg.numY; iy++) {
            const sliceY = vg.ofs.y + (iy + 0.5) * vg.res;
            const bnds = sliceContourByLine(cont, sliceY);

            let isOutside = true;
            for (let ix = 0; ix < vg.numX; ix++) {
                if (bnds.length === 0) {
                    vg.set(ix, iy, iz, 0);
                    continue;
                }

                const sliceX = vg.ofs.x + (ix + 0.5) * vg.res;

                if (bnds[0] <= sliceX) {
                    isOutside = !isOutside;
                    bnds.shift();
                }
                vg.set(ix, iy, iz, isOutside ? 0 : 255);
            }
        }
    }
    console.log(`dicing done; volume: ${vg.volume()} mm^3 (${vg.count()} voxels)`);
    return vg;
};

// contEdges: [x0, y0, x1, y1, ...]
// returns: seg set [x0, x1, x2, ...]
const sliceContourByLine = (contEdges, sliceY) => {
    const bnds = [];
    const numEdges = contEdges.length / 4;
    for (let i = 0; i < numEdges; i++) {
        const p0 = new THREE.Vector2(contEdges[4 * i + 0], contEdges[4 * i + 1]);
        const p1 = new THREE.Vector2(contEdges[4 * i + 2], contEdges[4 * i + 3]);

        const s0 = Math.sign(p0.y - sliceY);
        const s1 = Math.sign(p1.y - sliceY);

        // early exit
        if (s0 >= 0 && s1 >= 0) {
            continue;
        }
        if (s0 < 0 && s1 < 0) {
            continue;
        }

        const isect = isectLine2(p0, p1, sliceY);
        bnds.push({ x: isect.x, isEnter: s0 >= 0 });
    }
    bnds.sort((a, b) => a.x - b.x);

    const bndsClean = [];
    let insideness = 0; // supports non-manifold, nested surfaces by allowing multiple enter.
    bnds.forEach(b => {
        if (b.isEnter) {
            insideness++;
            if (insideness === 1) {
                bndsClean.push(b.x);
            }
        } else {
            insideness--;
            if (insideness === 0) {
                bndsClean.push(b.x);
            }
            if (insideness < 0) {
                console.error("Corrupt surface data (hole)");
            }
        }
    });
    if (insideness !== 0) {
        console.error("Corrupt surface data (hole)");
    }
    if (bndsClean.length % 2 !== 0) {
        bndsClean.pop();
    }

    return bndsClean;
};


// surfTris: [x0, y0, z0, x1, y1, z1, ...]
// returns: contour edges
const sliceSurfByPlane = (surfTris, sliceZ) => {
    const segs = [];

    // tris are CCW.
    const numTris = surfTris.length / 9;
    for (let i = 0; i < numTris; i++) {
        const p0 = new THREE.Vector3(surfTris[9 * i + 0], surfTris[9 * i + 1], surfTris[9 * i + 2]);
        const p1 = new THREE.Vector3(surfTris[9 * i + 3], surfTris[9 * i + 4], surfTris[9 * i + 5]);
        const p2 = new THREE.Vector3(surfTris[9 * i + 6], surfTris[9 * i + 7], surfTris[9 * i + 8]);

        const s0 = Math.sign(p0.z - sliceZ);
        const s1 = Math.sign(p1.z - sliceZ);
        const s2 = Math.sign(p2.z - sliceZ);

        // early exit
        if (s0 >= 0 && s1 >= 0 && s2 >= 0) {
            continue;
        }
        if (s0 < 0 && s1 < 0 && s2 < 0) {
            continue;
        }

        // intersect 3 edges with
        let up = null;
        let down = null;
        if (s0 < 0 && s1 >= 0) {
            up = isectLine(p0, p1, sliceZ);
        } else if (s0 >= 0 && s1 < 0) {
            down = isectLine(p0, p1, sliceZ);
        }

        if (s1 < 0 && s2 >= 0) {
            up = isectLine(p1, p2, sliceZ);
        } else if (s1 >= 0 && s2 < 0) {
            down = isectLine(p1, p2, sliceZ);
        }

        if (s2 < 0 && s0 >= 0) {
            up = isectLine(p2, p0, sliceZ);
        } else if (s2 >= 0 && s0 < 0) {
            down = isectLine(p2, p0, sliceZ);
        }

        if (up === null || down === null) {
            throw "Degenerate triangle";
        }

        segs.push(down.x, down.y, up.x, up.y); // down -> up is CCW contor in XY plane.
    }

    return segs;
};

const loadStl = (fname) => {
    const loader = new STLLoader();
    loader.load(
        `models/${fname}.stl`,
        function (geometry) {
            objSurf = convGeomToSurf(geometry);

            const material = new THREE.MeshPhysicalMaterial({
                color: 0xb2ffc8,
                metalness: 0.1,
                roughness: 0.8,
                transparent: true,
                opacity: 0.1,
            });

            if (view.visObj) {
                view.scene.remove(view.visObj);
                view.visObj = null;
            }

            const mesh = new THREE.Mesh(geometry, material)
            view.scene.add(mesh);
            view.visObj = mesh;
        },
        (xhr) => {
            console.log((xhr.loaded / xhr.total) * 100 + '% loaded')
        },
        (error) => {
            console.log(error);
        }
    );
};



// returns: THREE.Object3D
const createContourVis = (edges) => {
    const geom = new THREE.BufferGeometry();
    const vertices = new Float32Array(edges.length / 2 * 3);
    for (let i = 0; i < edges.length / 2; i++) {
        vertices[3 * i + 0] = edges[2 * i + 0];
        vertices[3 * i + 1] = edges[2 * i + 1];
        vertices[3 * i + 2] = 0;
    }
    geom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));

    const matEdges = new THREE.LineBasicMaterial({ color: 0x8080a0 });
    const objEdges = new THREE.LineSegments(geom, matEdges);
    const objPoints = new THREE.Points(geom, new THREE.PointsMaterial({ color: 0x8080f0, size: 3 }));
    objEdges.add(objPoints);

    return objEdges;
};

// returns: THREE.Object3D
const createBndsVis = (bnds) => {
    const geom = new THREE.BufferGeometry();
    const vertices = new Float32Array(bnds.length * 3);
    for (let i = 0; i < bnds.length; i++) {
        vertices[3 * i + 0] = bnds[i];
        vertices[3 * i + 1] = 0;
        vertices[3 * i + 2] = 0;
    }
    geom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));

    const matEdges = new THREE.LineBasicMaterial({ color: 0x80a080 });
    const objEdges = new THREE.LineSegments(geom, matEdges);
    const objPoints = new THREE.Points(geom, new THREE.PointsMaterial({ color: 0x80f080, size: 3 }));
    objEdges.add(objPoints);

    return objEdges;
};

// returns: THREE.Object3D
const createVgVis = (vg) => {
    const cubeGeom = new THREE.BoxGeometry(dicer.resMm * 0.9, dicer.resMm * 0.9, dicer.resMm * 0.9);

    const num = vg.count();
    const mesh = new THREE.InstancedMesh(cubeGeom, new THREE.MeshNormalMaterial(), num);
    let instanceIx = 0;
    for (let iz = 0; iz < vg.numZ; iz++) {
        for (let iy = 0; iy < vg.numY; iy++) {
            for (let ix = 0; ix < vg.numX; ix++) {
                const v = vg.get(ix, iy, iz);
                if (v === 0) {
                    continue;
                }

                const mtx = new THREE.Matrix4();
                mtx.compose(
                    new THREE.Vector3(ix, iy, iz).addScalar(0.5).multiplyScalar(vg.res).add(vg.ofs),
                    new THREE.Quaternion(),
                    new THREE.Vector3(1, 1, 1).multiplyScalar(v / 255));
                mesh.setMatrixAt(instanceIx, mtx);
                instanceIx++;
            }
        }
    }
    return mesh;
};

const generateBlankGeom = () => {
    const blankRadius = 25;
    const blankHeight = 50;
    const geom = new THREE.CylinderGeometry(blankRadius, blankRadius, blankHeight, 64, 1);
    const transf = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 0, blankHeight / 2),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
        new THREE.Vector3(1, 1, 1));
    geom.applyMatrix4(transf);
    return geom;
};

const generateBlank = () => {
    const blank = new THREE.Mesh(
        generateBlankGeom(),
        new THREE.MeshLambertMaterial({ color: "blue", wireframe: true }));
    return blank;
};

const generateTool = () => {
    // 25G needle
    const needleExtRadius = 0.51 / 2;
    const needleLength = 25;
    const wireRadius = 0.25 / 2;
    const wireExtrusion = wireRadius * 2;

    const needle = new THREE.Mesh(
        new THREE.CylinderGeometry(needleExtRadius, needleExtRadius, needleLength, 32, 1),
        new THREE.MeshPhysicalMaterial({ color: 0xf0f0f0, metalness: 0.9, roughness: 0.3 }));
    needle.position.y = needleLength / 2;

    const wire = new THREE.Mesh(
        new THREE.CylinderGeometry(wireRadius, wireRadius, wireExtrusion, 16, 1),
        new THREE.MeshPhysicalMaterial({ color: "red", metalness: 0.9, roughness: 0.7 }));
    needle.add(wire);
    wire.position.y = needleLength / 2 + wireExtrusion / 2;

    return needle;
};

class View3D {
    constructor() {
        this.tool = null;
        this.visNonVg = [];
        this.visVg = null;
        this.visObj = null;

        this.init();
    }

    init() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        // camera
        const aspect = width / height;
        this.camera = new THREE.OrthographicCamera(-50 * aspect, 50 * aspect, 50, -50, 0.1, 300);
        this.camera.position.x = -30;
        this.camera.position.y = -80;
        this.camera.position.z = 90;
        this.camera.up.set(0, 0, 1);

        // renderer

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(width, height);
        this.renderer.setAnimationLoop(() => this.animate());
        this.container = document.getElementById('container');
        this.container.appendChild(this.renderer.domElement);

        // scene (scene is in mm unit)

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xffffff);

        const light = new THREE.AmbientLight(0x404040); // soft white light
        this.scene.add(light);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(0, 0, 1);
        this.scene.add(directionalLight);

        const hemiLight = new THREE.HemisphereLight(0xffffbb, 0x080820, 1);
        this.scene.add(hemiLight);

        const gridHelper = new THREE.GridHelper(60, 6);
        this.scene.add(gridHelper);
        gridHelper.rotateX(Math.PI / 2);

        const axesHelper = new THREE.AxesHelper(8);
        this.scene.add(axesHelper);
        axesHelper.position.set(-29, -29, 0);

        this.tool = generateTool();
        this.scene.add(this.tool);

        const blank = generateBlank();
        this.scene.add(blank);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);

        this.stats = new Stats();
        container.appendChild(this.stats.dom);



        const guiStatsEl = document.createElement('div');
        guiStatsEl.classList.add('gui-stats');

        // listeners
        window.addEventListener('resize', () => this.onWindowResize());
        Object.assign(window, { scene: this.scene });
    }

    onWindowResize() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        this.renderer.setSize(width, height);
    }

    animate() {
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
        this.stats.update();
    }
}

function initGui(view) {
    const gui = new GUI();
    gui.add(dicer, 'model', Model).onChange((model) => {
        // delete vis
        if (view.visVg) {
            view.scene.remove(view.visVg);
        }
        view.visVg = null;

        view.visNonVg.forEach(v => view.scene.remove(v));
        view.visNonVg = [];

        // load new model
        loadStl(model);
    });
    gui.add(dicer, "resMm", [1e-3, 1e-2, 1e-1, 0.25, 0.5, 1]);
    gui.add(dicer, "showVoxels").onChange(v => {
        if (view.visVg) {
            view.visVg.visible = v;
        }
    }).listen();
    gui.add(dicer, "dice");

    gui.add(dicer, "lineZ", -10, 50).step(0.1);
    gui.add(dicer, "lineY", -50, 50).step(0.1);
    gui.add(dicer, "diceLine");

    gui.add(dicer, "toolX", -50, 50).step(0.1).onChange(v => view.tool.position.x = v);
    gui.add(dicer, "toolY", -50, 50).step(0.1).onChange(v => view.tool.position.y = v);
    gui.add(dicer, "toolZ", 0, 100).step(0.1).onChange(v => view.tool.position.z = v);
}


const Model = {
    HELICAL_GEAR: "helical_gear",
    DICE_TOWER: "dice_tower",
};

const dicer = {
    model: Model.HELICAL_GEAR,
    resMm: 0.5,
    lineZ: 1,
    lineY: 0,
    showVoxels: false,
    dice: () => {
        const blankSurf = convGeomToSurf(generateBlankGeom());
        diceAndVisualize(blankSurf, objSurf, dicer.resMm);
    },
    diceLine: () => {
        const sf = convGeomToSurf(generateBlankGeom());
        diceLineAndVisualize(objSurf, dicer.lineY, dicer.lineZ);
    },
    toolX: 0,
    toolY: 0,
    toolZ: 0,
};


loadStl(dicer.model);
const view = new View3D();
initGui(view);
