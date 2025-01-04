import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    initVG, initVGForPoints, diceSurf, sliceSurfByPlane, sliceContourByLine,
    resampleVG,
} from './geom.js';


// Apply translation to geometry in-place.
// [in]: THREE.BufferGeometry
// [in]: THREE.Vector3
const translateGeom = (geom, trans) => {
    const pos = geom.getAttribute("position").array;
    for (let i = 0; i < pos.length; i += 3) {
        pos[i + 0] += trans.x;
        pos[i + 1] += trans.y;
        pos[i + 2] += trans.z;
    }
};


// Get "triangle soup" representation from a geometry.
// [in]: THREE.BufferGeometry
// returns: TypedArray
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


// returns: THREE.BufferGeometry
const generateStockGeom = () => {
    const stockRadius = 7.5;
    const stockHeight = 15;
    const geom = new THREE.CylinderGeometry(stockRadius, stockRadius, stockHeight, 64, 1);
    const transf = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 0, stockHeight / 2),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
        new THREE.Vector3(1, 1, 1));
    geom.applyMatrix4(transf);
    return geom;
};


// [in]: VoxelGrid
// returns: THREE.Object3D
const createVgVis = (vg) => {
    const cubeGeom = new THREE.BoxGeometry(vg.res * 0.9, vg.res * 0.9, vg.res * 0.9);

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
                    new THREE.Vector3(ix, iy, iz).addScalar(0.5).multiplyScalar(vg.res),
                    new THREE.Quaternion(),
                    new THREE.Vector3(1, 1, 1).multiplyScalar(v / 255));
                mesh.setMatrixAt(instanceIx, mtx);
                instanceIx++;
            }
        }
    }

    const meshContainer = new THREE.Object3D();
    meshContainer.add(mesh);
    meshContainer.quaternion.copy(vg.rot);
    meshContainer.position.copy(vg.ofs);

    const axesHelper = new THREE.AxesHelper();
    axesHelper.scale.set(vg.res * vg.numX, vg.res * vg.numY, vg.res * vg.numZ);
    mesh.add(axesHelper);
    
    return meshContainer;
};


// [in] array of THREE.Vector3, path
// returns: THREE.Object3D
const createPathVis = (path) => {
    const vs = new Float32Array(path.length * 3);
    for (let i = 0; i < path.length; i++) {
        vs[3 * i + 0] = path[i].x;
        vs[3 * i + 1] = path[i].y;
        vs[3 * i + 2] = path[i].z;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(vs, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x808080 });
    return new THREE.Line(geom, mat);
};


// returns: THREE.Object3D
const generateStock = () => {
    const stock = new THREE.Mesh(
        generateStockGeom(),
        new THREE.MeshLambertMaterial({ color: "blue", wireframe: true, transparent: true, opacity: 0.05 }));
    return stock;
};


// returns: THREE.Object3D
const generateTool = () => {
    const toolOrigin = new THREE.Object3D();

    const baseRadius = 10;
    const baseHeight = 10;

    const needleExtRadius = 1.5 / 2;
    const needleLength = 25;

    const toolBase = new THREE.Mesh(
        new THREE.CylinderGeometry(baseRadius, baseRadius, baseHeight, 32, 1),
        new THREE.MeshPhysicalMaterial({ color: 0xe0e0e0, metalness: 0.2, roughness: 0.8 }));
    toolBase.position.y = -baseHeight / 2;
    toolOrigin.add(toolBase);

    const needle = new THREE.Mesh(
        new THREE.CylinderGeometry(needleExtRadius, needleExtRadius, needleLength, 32, 1),
        new THREE.MeshPhysicalMaterial({ color: 0xf0f0f0, metalness: 0.9, roughness: 0.3 }));
    needle.position.y = needleLength / 2;

    toolOrigin.add(needle);
    toolOrigin.rotateOnAxis(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    toolOrigin.position.x = needleLength + 10;

    return toolOrigin;
};


////////////////////////////////////////////////////////////////////////////////
// 3D view

const Model = {
    GT2_PULLEY: "GT2_pulley",
    HELICAL_GEAR: "helical_gear",
    HELICAL_GEAR_STANDING: "helical_gear_standing",
    DICE_TOWER: "dice_tower",
    BENCHY: "benchy_25p",
    BOLT_M3: "M3x10",
};


// Check if a is equal or subset of b.
// [in]: a VoxelGrid
// [in]: b VoxelGrid
// [out]: boolean
const checkIsSubset = (a, b) => {
    const c = b.clone().greaterOrEqual(a);
    return c.count() === c.numX * c.numY * c.numZ;
}

// Apply transformation to AABB, and return the transformed AABB.
// [in] min, max THREE.Vector3 in coordinates A.
// [in] mtx THREE.Matrix4 transforms (A -> B)
// returns: {min: THREE.Vector3, max: THREE.Vector3} in coordinates B.
const transformAABB = (min, max, mtx) => {
    const minB = new THREE.Vector3(1e100, 1e100, 1e100);
    const maxB = new THREE.Vector3(-1e100, -1e100, -1e100);
    for (let i = 0; i < 8; i++) {
        const cubeVertex = new THREE.Vector3(
            (i & 1) ? min.x : max.x,
            (i & 2) ? min.y : max.y,
            (i & 4) ? min.z : max.z,
        ).applyMatrix4(mtx);
        minB.min(cubeVertex);
        maxB.max(cubeVertex);
    }
    return { min: minB, max: maxB };
};


/**
 * Scene is in mm unit. Right-handed, Z+ up.
 */
class View3D {
    constructor() {
        this.init();
        this.visGroups = {};

        this.tool = generateTool();
        this.scene.add(this.tool);

        const stock = generateStock();
        this.objStock = stock;
        this.scene.add(stock);
        this.model = Model.GT2_PULLEY;
        this.showStockMesh = true;
        this.showTargetMesh = true;

        this.resMm = 0.5;
        this.lineZ = 1;
        this.lineY = 0;
        this.showWork = false;
        this.showTarget = false;
        this.targetSurf = null;
        this.millVgs = [];
        this.millStep = 0;
        this.toolX = 0;
        this.toolY = 0;
        this.toolZ = 0;

        this.numSweeps = 0;
        this.showingSweep = 0;
        this.showGenAccess = true;
        this.showGenSlice = true;
        this.showGenRemoval = true;
        this.showGenPath = true;

        this.initGui();
    }

    initGui() {
        const view = this;
        const loadStl = (fname) => {
            const loader = new STLLoader();
            loader.load(
                `models/${fname}.stl`,
                (geometry) => {
                    // To avoid parts going out of work by numerical error, slightly offset the part geometry.
                    translateGeom(geometry, new THREE.Vector3(0, 0, 0.5));
                    this.targetSurf = convGeomToSurf(geometry);

                    const material = new THREE.MeshPhysicalMaterial({
                        color: 0xb2ffc8,
                        metalness: 0.1,
                        roughness: 0.8,
                        transparent: true,
                        opacity: 0.8,
                    });

                    const mesh = new THREE.Mesh(geometry, material)
                    this.updateVis("target", [mesh]);
                },
                (xhr) => {
                    console.log((xhr.loaded / xhr.total) * 100 + '% loaded')
                },
                (error) => {
                    console.log(error);
                }
            );
        };

        const gui = new GUI();
        gui.add(this, 'model', Model).onChange((model) => {
            this.updateVis("vg-targ", []);
            this.updateVis("vg-work", []);
            this.updateVis("misc", []);
    
            loadStl(model);
        });
        gui.add(this, "showStockMesh").onChange(v => {
            this.objStock.visible = v;
        }).listen();
        gui.add(this, "showTargetMesh").onChange(v => {
            this.setVisVisibility("target", v);
        }).listen();

        gui.add(this, "resMm", [1e-3, 5e-2, 1e-2, 1e-1, 0.25, 0.5, 1]);
    
        gui.add(this, "initPlan");
        gui.add(this, "genNextSweep");
        gui.add(this, "numSweeps").disable().listen();
        gui.add(this, "showingSweep", 0, this.numSweeps).step(1).listen();
        gui.add(this, "showTarget")
            .onChange(_ => this.setVisVisibility("vg-targ", this.showTarget))
            .listen();
        gui.add(this, "showWork")
            .onChange(_ => this.setVisVisibility("vg-work", this.showWork))
            .listen();
        gui.add(this, "showGenAccess")
            .onChange(_ => this.setVisVisibility("vg-gen-access", this.showGenAccess))
            .listen();
        gui.add(this, "showGenSlice")
            .onChange(_ => this.setVisVisibility("vg-gen-slice", this.showGenSlice))
            .listen();
        gui.add(this, "showGenRemoval")
            .onChange(_ => this.setVisVisibility("vg-gen-removal", this.showGenRemoval))
            .listen();
        gui.add(this, "showGenPath")
            .onChange(_ => this.setVisVisibility("vg-gen-path", this.showGenPath))
            .listen();
    
        loadStl(this.model);
    }

    init() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        const aspect = width / height;
        this.camera = new THREE.OrthographicCamera(-25 * aspect, 25 * aspect, 25, -25, 0.1, 150);
        this.camera.position.x = 15;
        this.camera.position.y = 40;
        this.camera.position.z = 20;
        this.camera.up.set(1, 0, 0);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(width, height);
        this.renderer.setAnimationLoop(() => this.animate());
        this.container = document.getElementById('container');
        this.container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xffffff);

        const light = new THREE.AmbientLight(0x404040); // soft white light
        this.scene.add(light);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(0, 0, 1);
        this.scene.add(directionalLight);

        const hemiLight = new THREE.HemisphereLight(0xffffbb, 0x080820, 1);
        this.scene.add(hemiLight);


        const gridHelperBottom = new THREE.GridHelper(40, 4);
        const gridHelperTop = new THREE.GridHelper(40, 1);
        this.scene.add(gridHelperBottom);
        this.scene.add(gridHelperTop);
        gridHelperBottom.rotateX(Math.PI / 2);
        gridHelperTop.rotateX(Math.PI / 2);
        gridHelperTop.position.z = 40;

        const axesHelper = new THREE.AxesHelper(8);
        this.scene.add(axesHelper);
        axesHelper.position.set(-19, -19, 0);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);


        this.stats = new Stats();
        container.appendChild(this.stats.dom);

        const guiStatsEl = document.createElement('div');
        guiStatsEl.classList.add('gui-stats');


        window.addEventListener('resize', () => this.onWindowResize());
        Object.assign(window, { scene: this.scene });
    }

    initPlan() {
        this.numSweeps = 0;
        this.showingSweep = 0;

        this.stockSurf = convGeomToSurf(generateStockGeom());
        this.workVg = initVGForPoints(this.stockSurf, this.resMm);
        this.targVg = this.workVg.clone();
        diceSurf(this.stockSurf, this.workVg);
        diceSurf(this.targetSurf, this.targVg);
        console.log("stock is large enough", checkIsSubset(this.targVg, this.workVg));

        this.planPath = [];

        this.updateVis("vg-work", [createVgVis(this.workVg)], this.showWork);
        this.updateVis("vg-targ", [createVgVis(this.targVg)], this.showTarget);
        this.updateVis("vg-gen-path", [createPathVis(this.planPath)], this.showGenPath);
    }

    genNextSweep() {
        // preparation:
        // voxelize the work and target into 3-state (empty, partial, full) VG, at 0.25mm resolution
        //   incorporate work's uncertainty into the cell value (as partial)
        //
        // initialize planner
        //
        // loop:
        //   if the current state meeds end condition ("good enough" or "too much time"), end planning
        //   planner generates sweep candidates
        //   sweep candidates are evluated
        //   pick the best sweep, and commit it (best = make most progress in given time)
        //
        // planner
        //   have bunch of heuristics to generate sweep candidates and control tolerance schedule
        //   
        // --
        // cf. good general rule
        //   1. to each work voxel, assign distance from targe surface
        //   2a. each voxel has distance cost + "switching cost" (from whatever current state of the tool shape & pos)
        //   2b. pick lowest overall cost voxel
        //   2c. loop until all work is removed
        //
        //   this is nice framework, but tiny difference in cost function can greatly change the generated path,
        //   making it fun but less understandable for users. also, this cannot accomodate EWR variance and non-linear phenomena.
        //   Thus should only be used as very general heuristic & localized with in pass,
        //   not as the middle thing.

        const candidateNormals = [
            new THREE.Vector3(1, 0, 0),
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(-1, 0, 0),
            new THREE.Vector3(0, -1, 0),
            new THREE.Vector3(0, 0, 1),
        ];

        // "surface" x canditateNormal
        // compute accessible area from shape x tool base
        //
        // reproject to 0.25mm grid of normal dir as local-Z.
        // compute "access grid"
        //   convolve tool radius in local XY-direction
        //   apply projecting-or in Z- direction
        //   now this grid's empty cells shows accessible locations to start milling from
        // pick the shallowed layer that contains voxels to be removed
        // compute the accesssible voxel in the surface, using zig-zag pattern
        // compute actual path (pre g-code)
        //
        // apply the removal to the work vg (how?)

        const diffVg = this.workVg.clone().sub(this.targVg.clone().saturateFill());
        if (diffVg.count() === 0) {
            console.log("done!");
            return;
        }

        // Prepare new (rotated) VG for projecting the work.
        // [in] normal THREE.Vector3, world coords. Local Z+ will point normal.
        // returns: VoxelGrid, empty voxel grid
        const initReprojGrid = (normal, res) => {
            // orthogonalize, with given Z-basis.
            const basisZ = normal;
            let basisY;
            const b0 = new THREE.Vector3(1, 0, 0);
            const b1 = new THREE.Vector3(0, 1, 0);
            if (b0.clone().cross(basisZ).length() > 0.3) {
                basisY = b0.clone().cross(basisZ).normalize();
            } else {
                basisY = b1.clone().cross(basisZ).normalize();
            }
            const basisX = basisY.clone().cross(basisZ).normalize();

            // init new grid
            const lToWMat3 = new THREE.Matrix3(
                basisX.x, basisY.x, basisZ.x,
                basisX.y, basisY.y, basisZ.y,
                basisX.z, basisY.z, basisZ.z,
            );

            const lToWQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().setFromMatrix3(lToWMat3));
            const workMin = this.workVg.ofs.clone();
            const workMax = new THREE.Vector3(this.workVg.numX, this.workVg.numY, this.workVg.numZ).multiplyScalar(this.workVg.res).add(workMin);
            
            const wToLMtx = new THREE.Matrix4().compose(
                new THREE.Vector3(0, 0, 0),
                lToWQ.clone().invert(),
                new THREE.Vector3(1, 1, 1));
            const aabbLoc = transformAABB(workMin, workMax, wToLMtx);
            console.log("aabb", workMin, workMax, "->", aabbLoc.min, aabbLoc.max);

            return initVG(aabbLoc, res, lToWQ, false, 5);
        };

        const accesGridRes = this.resMm;
        const normal = candidateNormals[0]; // new THREE.Vector3(1, 1, 1).normalize(); //  candidateNormals[0];

        const passAccess = initReprojGrid(normal, accesGridRes);
        const passDiff = passAccess.clone();
        const passRemoval = passAccess.clone();
        resampleVG(passAccess, this.workVg);
        passAccess.extendByRadiusXY(1.5 / 2);
        passAccess.scanZMaxDesc();
        console.log(passAccess);
        this.updateVis("vg-gen-access", [createVgVis(passAccess)], this.showGenAccess);

        //this.updateVis("vg-gen", [createVgVis(accessGrid)]);
        resampleVG(passDiff, diffVg);
        const passMaxZ = passDiff.findMaxNonZeroZ();
        console.log("passMaxZ", passMaxZ);

        // prepare 2D-scan at Z= passMaxZ.
        passDiff.filterZ(passMaxZ);

        let minScore = 1e100;
        let minPt = null;
        for (let iy = 0; iy < passDiff.numY; iy++) {
            for (let ix = 0; ix < passDiff.numX; ix++) {
                const v = passDiff.get(ix, iy, passMaxZ);
                if (v > 0) {
                    const score = ix + iy;
                    if (score < minScore) {
                        minScore = score;
                        minPt = new THREE.Vector2(ix, iy);
                    }
                }
            }
        }
        console.log("minPt", minPt);
        // TODO: VERY FRAGILE
        const access = passAccess.get(minPt.x, minPt.y, passMaxZ + 1); // check previous layer's access
        const accessOk = access === 0;
        console.log("accessOk", accessOk);
        
        // generate zig-zag
        let dirR = true; // true: right, false: left
        let currIx = minPt.x;
        let currIy = minPt.y;
        while (true) {
            passRemoval.set(currIx, currIy, passMaxZ, 255);
            this.planPath.push(passDiff.centerOf(currIx, currIy, passMaxZ));

            const nextIx = currIx + (dirR ? 1 : -1);
            const next = passDiff.get(nextIx, currIy, passMaxZ);
            const up = passDiff.get(currIx, currIy + 1, passMaxZ);

            if (next === 0 && up === 0) {
                break;
            }
            if (next !== 0) {
                currIx = nextIx;
            } else {
                dirR = !dirR;
                currIy++;
            }
            // TODO: tool wear handling
        }
        this.numSweeps++;
        this.showingSweep++;

        this.updateVis("vg-gen-slice", [createVgVis(passDiff)], this.showGenSlice);

        this.updateVis("vg-gen-path", [createPathVis(this.planPath)], this.showGenPath);

        const deltaWork = this.workVg.clone();
        deltaWork.fill(0);
        passRemoval.extendByRadiusXY(1.5 / 2);
        resampleVG(deltaWork, passRemoval);
        this.updateVis("vg-gen-removal", [createVgVis(deltaWork)], this.showGenRemoval);

        this.workVg.sub(deltaWork);
        this.updateVis("vg-work", [createVgVis(this.workVg)], this.showWork);
    }

    updateVis(group, vs, visible = true) {
        if (this.visGroups[group]) {
            this.visGroups[group].forEach(v => this.scene.remove(v));
        }
        vs.forEach(v => {
            this.scene.add(v);
            v.visible = visible;
        });
        this.visGroups[group] = vs;
    }

    setVisVisibility(group, visible) {
        if (this.visGroups[group]) {
            this.visGroups[group].forEach(v => v.visible = visible);
        }
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


////////////////////////////////////////////////////////////////////////////////
// entry point

const view = new View3D();
