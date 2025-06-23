// Fake declarations for all third-party modules
// Everything exports 'any' to avoid type checking third-party code

declare module 'three' {
  export class Vector2 {
    x: number;
    y: number;
    constructor(x?: number, y?: number);
    [key: string]: any; // Allow any methods
  }
  export class Vector3 {
    x: number;
    y: number;
    z: number;
    constructor(x?: number, y?: number, z?: number);
    [key: string]: any; // Allow any methods
  }
  export class Vector4 {
    x: number;
    y: number;
    z: number;
    w: number;
    constructor(x?: number, y?: number, z?: number, w?: number);
    [key: string]: any; // Allow any methods
  }
  export class Color {
    constructor();
    constructor(color: string | number | Color);
    constructor(r: number, g: number, b: number);
    [key: string]: any;
  }
  export class Matrix4 {
    constructor();
    constructor(
      n11?: number, n12?: number, n13?: number, n14?: number,
      n21?: number, n22?: number, n23?: number, n24?: number,
      n31?: number, n32?: number, n33?: number, n34?: number,
      n41?: number, n42?: number, n43?: number, n44?: number
    );
    [key: string]: any;
  }
  export class BufferGeometry {
    constructor();
    [key: string]: any;
  }
  export class BufferAttribute {
    constructor(array: any, itemSize: number);
    [key: string]: any;
  }
  export class Object3D {
    constructor();
    [key: string]: any;
  }
  export const Scene: any;
  export const Camera: any;
  export const PerspectiveCamera: any;
  export const OrthographicCamera: any;
  export const WebGLRenderer: any;
  export const Mesh: any;
  export const Material: any;
  export const MeshBasicMaterial: any;
  export const MeshStandardMaterial: any;
  export const MeshPhysicalMaterial: any;
  export const DirectionalLight: any;
  export const AmbientLight: any;
  export const HemisphereLight: any;
  export const DataTexture: any;
  export const DepthTexture: any;
  export const WebGLRenderTarget: any;
  export const ShaderMaterial: any;
  export const BoxGeometry: any;
  export const GridHelper: any;
  export const PMREMGenerator: any;
  export const Sphere: any;
  export const Float32BufferAttribute: any;
  export const Box3: any;
  export const Euler: any;
  export const CylinderGeometry: any;
  export const SphereGeometry: any;
  export const LineLoop: any;
  export const LineBasicMaterial: any;
  export const Quaternion: any;
  export const AxesHelper: any;
  export const InstancedMesh: any;
  export const MeshLambertMaterial: any;
  export const MeshNormalMaterial: any;
  export const LineSegments: any;
  export const REVISION: any;
  export const DoubleSide: any;
  export const FloatType: any;
  export const HalfFloatType: any;
  export const RedFormat: any;
  export const RGBAFormat: any;
  export const DepthFormat: any;
  export const DepthStencilFormat: any;
  export const LinearFilter: any;
  export const NearestFilter: any;
  export const RepeatWrapping: any;
  export const NoColorSpace: any;
  export const UnsignedIntType: any;
  export const UnsignedInt248Type: any;
  export default {} as any;
}

declare module 'three/addons/*' {
  export const Pass: any;
  export const EffectComposer: any;
  export const RenderPass: any;
  export const OutputPass: any;
  export const ShaderPass: any;
  export const MaskPass: any;
  export const STLLoader: any;
  export const FontLoader: any;
  export const TextGeometry: any;
  export const OrbitControls: any;
  export const BufferGeometryUtils: any;
  export const Stats: any;
  export const GUI: any;
  export const CopyShader: any;
  export const OutputShader: any;
  export default {} as any;
}

declare module 'vendor/n8ao/N8AO.js' {
  export const N8AOPass: any;
  export default {} as any;
}

declare module 'vendor/three/three.module.min.js' {
  export default {} as any;
}

declare module 'vendor/three/addons/*' {
  export default {} as any;
}

// Set.difference() method (newer JS feature)
interface Set<T> {
  difference(other: Set<T>): Set<T>;
}

// lilgui global
declare const lilgui: any;
