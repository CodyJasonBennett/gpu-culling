import * as THREE from 'three'
import { OrbitControls } from 'three/addons'

const VARYING_REGEX = /[^\w](?:varying|out)\s+\w+\s+(\w+)\s*;/g

/** @type {WebGLTransformFeedback | null} */
let _transformFeedback = null

/** @type {WeakMap<THREE.ShaderMaterial, THREE.ShaderMaterial>} */
const _compiled = new WeakMap()
const _camera = new THREE.Camera()

const DEFAULT_FRAGMENT = new THREE.ShaderMaterial().fragmentShader // default_fragment

/**
 *
 * @param {THREE.Mesh} node
 */
THREE.WebGLRenderer.prototype.compute = function (node) {
  const skipRaster = node.material.fragmentShader === DEFAULT_FRAGMENT

  /** @type {WebGL2RenderingContext} */
  const gl = this.getContext()

  // Create memoized compute material
  let oldMaterial = node.material
  let material = _compiled.get(node.material)
  if (!material) {
    material = node.material.clone()
    material.vertexShader = node.material.computeShader
    if (skipRaster) material.fragmentShader = 'out lowp vec4 c;void main(){c=vec4(0);}'
    material.uniforms = node.material.uniforms
    _compiled.set(node.material, material)
  }
  node.material = material

  // Prime and get compiled program
  // NOTE: compile doesn't populate this.attributes
  // https://github.com/mrdoob/three.js/pull/26777
  this.render(node, _camera)
  const materialProperties = this.properties.get(material)
  const compiled = materialProperties.currentProgram
  const program = compiled.program

  _transformFeedback ??= gl.createTransformFeedback()
  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, _transformFeedback)

  if (!compiled.outputs) {
    compiled.outputs = []

    // Get compiled source with resolved shader chunks
    const vertexShader = gl.getShaderSource(compiled.vertexShader)

    // Feedback shader outputs from source
    // TODO: interleave attributes for limits
    for (const [, output] of vertexShader.matchAll(VARYING_REGEX)) {
      const attribute = node.geometry.attributes[output]
      const { buffer } = this.attributes.get(attribute)
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, compiled.outputs.length, buffer)
      compiled.outputs.push(output)
    }

    gl.transformFeedbackVaryings(program, compiled.outputs, gl.SEPARATE_ATTRIBS)
    gl.linkProgram(program)

    const error = gl.getProgramInfoLog(program)
    if (error) throw new Error(error)

    // Force reset uniforms after relink
    for (const uniform of materialProperties.uniformsList) {
      uniform.addr = gl.getUniformLocation(program, uniform.id)
      uniform.cache = []
    }
  }

  if (!skipRaster) gl.enable(gl.RASTERIZER_DISCARD)

  gl.beginTransformFeedback(gl.TRIANGLES)
  this.render(node, _camera)
  gl.endTransformFeedback()

  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null)
  if (!skipRaster) gl.disable(gl.RASTERIZER_DISCARD)
  node.material = oldMaterial

  // Debug CPU readback
  // for (const output of compiled.outputs) {
  //   const attribute = node.geometry.attributes[output]
  //   const { buffer } = this.attributes.get(attribute)

  //   gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  //   gl.getBufferSubData(gl.ARRAY_BUFFER, 0, attribute.array)
  //   gl.bindBuffer(gl.ARRAY_BUFFER, null)

  //   console.log(output, ...Array.from(attribute.array))
  // }
}

THREE.ShaderMaterial.prototype.computeShader = ''

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
document.body.appendChild(renderer.domElement)

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight)
camera.position.z = 5

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true

const scene = new THREE.Scene()

const geometry = new THREE.BufferGeometry()
geometry.setDrawRange(0, 3)
geometry.boundingSphere = new THREE.Sphere().set(new THREE.Vector3(), Infinity)
geometry.attributes = {
  radius: new THREE.BufferAttribute(new Float32Array(3), 1),
  position: new THREE.BufferAttribute(new Float32Array(9), 3),
  visibility: new THREE.InstancedBufferAttribute(new Int32Array(3), 1),
}
geometry.attributes.visibility.gpuType = THREE.IntType

const projectionViewMatrix = new THREE.Matrix4()

const cullMaterial = new THREE.RawShaderMaterial({
  uniforms: {
    projectionViewMatrix: new THREE.Uniform(projectionViewMatrix),
    resolution: new THREE.Uniform(new THREE.Vector2()),
    mipmaps: new THREE.Uniform(null),
  },
  computeShader: /* glsl */ `//#version 300 es
    uniform mat4 projectionViewMatrix;
    uniform vec2 resolution;
    uniform sampler2D[6] mipmaps;

    in float radius;
    in vec3 position;
    flat out int visibility;

    vec4 textureGather(sampler2D tex, vec2 uv, int comp) {
      vec2 res = vec2(textureSize(tex, 0));
      ivec2 p = ivec2((uv * res) - 0.5);
      return vec4(
        texelFetchOffset(tex, p, 0, ivec2(0, 1))[comp],
        texelFetchOffset(tex, p, 0, ivec2(1, 1))[comp],
        texelFetchOffset(tex, p, 0, ivec2(1, 0))[comp],
        texelFetchOffset(tex, p, 0, ivec2(0, 0))[comp]
      );
    }

    void main() {
      bool visible = true;

      // Frustum cull
      if (visible) {
        // http://cs.otago.ac.nz/postgrads/alexis/planeExtraction.pdf
        mat4 frustum = transpose(projectionViewMatrix);
        vec4 planes[] = vec4[](
          frustum[3] - frustum[0], // left   (-w < +x)
          frustum[3] + frustum[0], // right  (+x < +w)
          frustum[3] - frustum[1], // bottom (-w < +y)
          frustum[3] + frustum[1], // top    (+y < +w)
          frustum[3] - frustum[2], // near   (-w < +z)
          frustum[3] + frustum[2]  // far    (+z < +w)
        );

        for (int i = 0; i < 6; i++) {
          float distance = dot(planes[i], vec4(position, 1));
          if (distance < -radius) {
            visible = false;
            break;
          }
        }
      }

      // Occlusion cull
      if (visible) {
        // Calculate NDC from projected position
        vec4 ndc = projectionViewMatrix * vec4(position.xy, position.z - radius, 1);
        ndc.xyz /= ndc.w;

        // Calculate screen-space UVs
        vec2 uv = (ndc.xy + 1.0) * 0.5;

        // Calculate Hi-Z mip
        int mip = clamp(int(ceil(log2(radius * resolution))), 0, 5);

        // Calculate max depth
        vec4 tile;
        if (mip == 0) tile = textureGather(mipmaps[0], uv, 0);
        if (mip == 1) tile = textureGather(mipmaps[1], uv, 0);
        if (mip == 2) tile = textureGather(mipmaps[2], uv, 0);
        if (mip == 3) tile = textureGather(mipmaps[3], uv, 0);
        if (mip == 4) tile = textureGather(mipmaps[4], uv, 0);
        if (mip == 5) tile = textureGather(mipmaps[5], uv, 0);
        float depth = max(max(tile.x, tile.y), max(tile.z, tile.w));

        // Test against conservative depth
        if (abs(ndc.z - depth) < 0.01 && depth > ndc.z) visible = false;
      }

      // Write visibility
      visibility = visible ? 1 : 0;
    }
  `,
  glslVersion: THREE.GLSL3,
})
const cullMesh = new THREE.Mesh(geometry, cullMaterial)

const normalMaterial = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `
    in int visibility;
    out vec3 vNormal;

    void main() {
      vNormal = normalMatrix * normal;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, visibility);
    }
  `,
  fragmentShader: /* glsl */ `
    in vec3 vNormal;

    void main() {
      gl_FragColor = vec4(normalize(vNormal) * 0.5 + 0.5, 1);
    }
  `,
})

const meshGeometry = new THREE.BoxGeometry()
meshGeometry.setAttribute('visibility', geometry.attributes.visibility)
meshGeometry.computeBoundingSphere()

const cube = new THREE.InstancedMesh(meshGeometry, normalMaterial, 1)
geometry.attributes.radius.array[0] = meshGeometry.boundingSphere.radius
scene.add(cube)

const plane = new THREE.Mesh(meshGeometry, new THREE.MeshNormalMaterial())
plane.position.z = 1
plane.scale.set(2, 2, 0.001)
plane.material.transparent = true
plane.material.opacity = 0.2
scene.add(plane)

const downsampleMaterial = new THREE.ShaderMaterial({
  uniforms: {
    tDepth: new THREE.Uniform(null),
  },
  vertexShader: /* glsl */ `
    out vec2 vUv;

    void main() {
      vUv = vec2(gl_VertexID << 1 & 2, gl_VertexID & 2);
      gl_Position = vec4(vUv * 2.0 - 1.0, 0, 1);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDepth;
    in vec2 vUv;

    vec4 textureGather(sampler2D tex, vec2 uv, int comp) {
      vec2 res = vec2(textureSize(tex, 0));
      ivec2 p = ivec2((uv * res) - 0.5);
      return vec4(
        texelFetchOffset(tex, p, 0, ivec2(0, 1))[comp],
        texelFetchOffset(tex, p, 0, ivec2(1, 1))[comp],
        texelFetchOffset(tex, p, 0, ivec2(1, 0))[comp],
        texelFetchOffset(tex, p, 0, ivec2(0, 0))[comp]
      );
    }

    void main() {
      vec4 tile = textureGather(tDepth, vUv, 0);
      float depth = max(max(tile.x, tile.y), max(tile.z, tile.w));
      gl_FragColor = vec4(depth, 0, 0, 1);
    }
  `,
})
const downsamplePass = new THREE.Mesh(geometry, downsampleMaterial)

const mipmaps = Array.from(
  { length: 6 },
  () =>
    new THREE.WebGLRenderTarget(0, 0, {
      minFilter: THREE.NearestFilter,
      type: THREE.HalfFloatType,
      format: THREE.RedFormat,
    }),
)
cullMaterial.uniforms.mipmaps.value = mipmaps.map((mipmap) => mipmap.texture)

const onResize = () => {
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.getDrawingBufferSize(cullMaterial.uniforms.resolution.value)

  for (let i = 0; i < 6; i++) {
    mipmaps[i].setSize(
      Math.max(1, Math.floor(window.innerWidth * Math.pow(0.5, i))),
      Math.max(1, Math.floor(window.innerHeight * Math.pow(0.5, i))),
    )
  }

  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
}
onResize()
window.addEventListener('resize', onResize)

const depthMaterial = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `
    void main() {
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1);
    }
  `,
  fragmentShader: /* glsl */ `
    void main() {
      gl_FragColor = vec4(gl_FragCoord.z, 0, 0, 1);
    }
  `,
})

renderer.setAnimationLoop(() => {
  controls.update()

  // Gather initial depth
  scene.overrideMaterial = depthMaterial
  renderer.setRenderTarget(mipmaps[0])
  renderer.render(scene, camera)
  scene.overrideMaterial = null

  // Create Hi-Z mip-chain
  for (let i = 1; i < 6; i++) {
    downsampleMaterial.uniforms.tDepth.value = mipmaps[i - 1].texture
    renderer.setRenderTarget(mipmaps[i])
    renderer.render(downsamplePass, camera)
  }
  renderer.setRenderTarget(null)

  // Perform occlusion culling
  camera.updateWorldMatrix()
  projectionViewMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  renderer.compute(cullMesh)

  // Render with culling
  renderer.render(scene, camera)
})
