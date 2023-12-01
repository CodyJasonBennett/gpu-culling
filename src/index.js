import * as THREE from 'three'
import { OrbitControls } from 'three/addons'

const VARYING_REGEX = /[^\w](?:varying|out)\s+\w+\s+(\w+)\s*;/g

/** @type {WebGLTransformFeedback | null} */
let _transformFeedback = null

/** @type {WeakMap<THREE.ShaderMaterial, THREE.ShaderMaterial>} */
const _compiled = new WeakMap()
const _camera = new THREE.Camera()

/**
 *
 * @param {THREE.Mesh} node
 */
THREE.WebGLRenderer.prototype.compute = function (node) {
  /** @type {WebGL2RenderingContext} */
  const gl = this.getContext()
  gl.enable(gl.RASTERIZER_DISCARD)

  // Create memoized compute material
  let oldMaterial = node.material
  let material = _compiled.get(node.material)
  if (!material) {
    material = node.material.clone()
    material.vertexShader = node.material.computeShader
    material.fragmentShader = 'out lowp vec4 c;void main(){c=vec4(0);}'
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

  // TODO: better cleanup to prevent state leak
  gl.bindVertexArray(null)
  gl.bindBuffer(gl.ARRAY_BUFFER, null)
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)
  gl.bindBuffer(gl.UNIFORM_BUFFER, null)

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

  gl.beginTransformFeedback(gl.TRIANGLES)
  this.render(node, _camera)
  gl.endTransformFeedback()

  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null)
  gl.disable(gl.RASTERIZER_DISCARD)
  node.material = oldMaterial

  // Debug CPU readback
  for (const output of compiled.outputs) {
    const attribute = node.geometry.attributes[output]
    const { buffer } = this.attributes.get(attribute)

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.getBufferSubData(gl.ARRAY_BUFFER, 0, attribute.array)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)

    console.log(output, Array.from(attribute.array)[0])
  }
}

THREE.ShaderMaterial.prototype.computeShader = ''

const renderer = new THREE.WebGLRenderer()
renderer.setSize(window.innerWidth, window.innerHeight)
document.body.appendChild(renderer.domElement)

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight)
camera.position.z = 5
// camera.position.x = 4
// camera.lookAt(0, 0, 0)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true

const scene = new THREE.Scene()

const geometry = new THREE.BufferGeometry()
geometry.setDrawRange(0, 3)
geometry.boundingSphere = new THREE.Sphere().set(new THREE.Vector3(), Infinity)
// geometry.setAttribute('visibility', new THREE.BufferAttribute(new Int32Array(3), 1))
// geometry.attributes.visibility.gpuType = THREE.IntType
geometry.setAttribute('console', new THREE.BufferAttribute(new Float32Array(3), 1))

const projectionViewMatrix = new THREE.Matrix4()

const material = new THREE.RawShaderMaterial({
  uniforms: {
    resolution: new THREE.Uniform(new THREE.Vector2()),
    projectionViewMatrix: new THREE.Uniform(projectionViewMatrix),
    mipmaps: new THREE.Uniform(null),
    radius: new THREE.Uniform(),
  },
  computeShader: /* glsl */ `//#version 300 es
    uniform vec2 resolution;
    uniform mat4 projectionViewMatrix;
    uniform sampler2D[6] mipmaps;
    uniform float radius;

    out float console;

    // const float radius = 0.87;
    const vec4 position = vec4(0, 0, 0, 1);

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
      if (false) {
        // http://cs.otago.ac.nz/postgrads/alexis/planeExtraction.pdf
        vec4 planes[] = vec4[](
          projectionViewMatrix[3] - projectionViewMatrix[0], // left   (-w < +x)
          projectionViewMatrix[3] + projectionViewMatrix[0], // right  (+x < +w)
          projectionViewMatrix[3] - projectionViewMatrix[1], // bottom (-w < +y)
          projectionViewMatrix[3] + projectionViewMatrix[1], // top    (+y < +w)
          projectionViewMatrix[3] - projectionViewMatrix[2], // near   (-w < +z)
          projectionViewMatrix[3] + projectionViewMatrix[2]  // far    (+z < +w)
        );

        for (int i = 0; i < 6; i++) {
          float distance = dot(planes[i], position);
          if (distance <= -radius) {
            visible = false;
            break;
          }
        }
      }

      console = -1.0;

      // Occlusion cull
      if (visible) {
        // Calculate NDC from projected position
        vec4 ndc = transpose(projectionViewMatrix) * vec4(position.xy, position.z - radius, 1);
        ndc.xyz /= ndc.w;

        // Calculate screen-space UVs
        vec2 uv = (ndc.xy + 1.0) * 0.5;

        // Calculate Hi-Z mip
        int mip = clamp(int(ceil(log2(radius * resolution))), 0, 5);
        mip = 0; // TODO: safer clamp

        // Calculate max depth
        vec4 tile;
        if (mip == 0) tile = textureGather(mipmaps[0], uv, 0);
        if (mip == 1) tile = textureGather(mipmaps[1], uv, 0);
        if (mip == 2) tile = textureGather(mipmaps[2], uv, 0);
        if (mip == 3) tile = textureGather(mipmaps[3], uv, 0);
        if (mip == 4) tile = textureGather(mipmaps[4], uv, 0);
        if (mip == 5) tile = textureGather(mipmaps[5], uv, 0);
        float depth = max(max(tile.x, tile.y), max(tile.z, tile.w));

        console = ndc.z;

        // Test against conservative depth
        if (abs(depth - ndc.z) > 0.01 && depth > ndc.z) visible = false;
      }

      // Write visibility
      // visibility = visible ? 0 : 2;
    }
  `,
  vertexShader: /* glsl */ `//#version 300 es
    out vec2 vUv;
    // in int visibility;
    in float console;

    void main() {
      vUv = vec2(gl_VertexID << 1 & 2, gl_VertexID & 2);
      gl_Position = vec4(vUv * 2.0 - 1.0, 0, 1);
    }
  `,
  fragmentShader: /* glsl */ `//#version 300 es
    precision lowp float;

    in vec2 vUv;
    out vec4 color;

    void main() {
      color = vec4(vUv, 0, 0.5);
    }
  `,
  transparent: true,
  glslVersion: THREE.GLSL3,
})
const mesh = new THREE.Mesh(geometry, material)
// scene.add(mesh)

const blitMaterial = new THREE.ShaderMaterial({
  uniforms: {
    tDepth: new THREE.Uniform(null),
    cameraNear: new THREE.Uniform(camera.near),
    cameraFar: new THREE.Uniform(camera.far),
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
    uniform float cameraNear;
    uniform float cameraFar;
    in vec2 vUv;

    #include <packing>

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
      gl_FragDepth = max(max(tile.x, tile.y), max(tile.z, tile.w));

      float viewZ = perspectiveDepthToViewZ(gl_FragDepth, cameraNear, cameraFar);
      float depth = viewZToOrthographicDepth(viewZ, cameraNear, cameraFar);
      gl_FragColor = vec4(vec3(1.0 - depth), 1);
    }
  `,
})
const blitMesh = new THREE.Mesh(geometry, blitMaterial)

const cube = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshNormalMaterial())
cube.geometry.computeBoundingSphere()
material.uniforms.radius.value = cube.geometry.boundingSphere.radius
scene.add(cube)

const plane = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshNormalMaterial())
plane.position.z = 1
plane.scale.setScalar(2)
plane.material.transparent = true
plane.material.opacity = 0.2
// scene.add(plane)

const renderTarget = new THREE.WebGLRenderTarget()
renderTarget.depthBuffer = true
renderTarget.depthTexture = new THREE.DepthTexture()

const onResize = () => {
  material.uniforms.resolution.value.set(window.innerWidth, window.innerHeight)
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderTarget.setSize(window.innerWidth, window.innerHeight)
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
}
onResize()
window.addEventListener('resize', onResize)

let width = window.innerWidth
let height = window.innerHeight
const numLevels = Math.min(6, 1 + Math.floor(Math.log2(Math.max(width, height))))

const mipmaps = [renderTarget]
for (let i = 1; i < numLevels; i++) {
  width = Math.max(1, Math.floor(width * 0.5))
  height = Math.max(1, Math.floor(height * 0.5))

  const mipmap = new THREE.WebGLRenderTarget(width, height)
  mipmap.depthBuffer = true
  mipmap.depthTexture = new THREE.DepthTexture()

  mipmaps[i] = mipmap
}

material.uniforms.mipmaps.value = mipmaps.map((mipmap) => mipmap.depthTexture)

renderer.setAnimationLoop(() => {
  controls.update()

  camera.updateWorldMatrix()
  projectionViewMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).transpose()

  renderer.setRenderTarget(renderTarget)
  renderer.render(scene, camera)

  for (let i = 1; i < numLevels; i++) {
    blitMaterial.uniforms.tDepth.value = mipmaps[i - 1].depthTexture
    renderer.setRenderTarget(mipmaps[i])
    renderer.render(blitMesh, camera)
  }

  // blitMaterial.uniforms.tDepth.value = renderTarget.depthTexture

  renderer.setRenderTarget(null)
  renderer.render(blitMesh, camera)

  renderer.compute(mesh)
  // renderer.render(mesh, camera)
})
