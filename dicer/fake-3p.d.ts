// Fake declarations for all third-party modules
// Everything exports 'any' to avoid type checking third-party code

declare module 'three' {
  export const Vector2: any;
  export const Vector3: any;
  export const Vector4: any;
  export const Color: any;
  export const Matrix4: any;
  export const BufferGeometry: any;
  export const BufferAttribute: any;
  export const Object3D: any;
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

declare module './N8AO.js' {
  export const N8AOPass: any;
  export default {} as any;
}

declare module './three.module.min.js' {
  export default {} as any;
}

declare module './three-addons/*' {
  export default {} as any;
}

// WebGPU globals that your code uses
declare const GPUBufferUsage: any;
declare const GPUShaderStage: any; 
declare const GPUMapMode: any;
declare const GPUBuffer: any;
declare const GPUCommandEncoder: any;
declare const GPUComputePipeline: any;
declare const GPUDevice: any;

// WebGPU shader types for JSDoc
type u32 = number;
type f32 = number;
type vec3f = number[];
type vec4f = number[];

// Navigator WebGPU extension
interface Navigator {
  gpu?: any;
}