import * as THREE from 'three'

const VARYING_REGEX = /[^\w](?:varying|out)\s+\w+\s+(\w+)\s*;/g

let _id = -1

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
    node.material.name = `compute${_id++}`
  }
  node.material = material

  // Prime and get compiled program
  // NOTE: compile doesn't populate this.attributes
  // https://github.com/mrdoob/three.js/pull/26777
  this.render(node, _camera)
  const compiled = this.programs.programs.find((program) => program.name === node.material.name)
  const program = compiled.program

  // TODO: better cleanup to prevent state leak
  gl.bindVertexArray(null)
  gl.bindBuffer(gl.ARRAY_BUFFER, null)
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)

  _transformFeedback ??= gl.createTransformFeedback()
  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, _transformFeedback)

  // Get compiled source with resolved shader chunks
  const vertexShader = gl.getShaderSource(compiled.vertexShader)

  // Feedback shader outputs from source
  // TODO: interleave attributes for limits
  const outputs = []
  for (const [, output] of vertexShader.matchAll(VARYING_REGEX)) {
    const attribute = node.geometry.attributes[output]
    const { buffer } = this.attributes.get(attribute)
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, outputs.length, buffer)
    outputs.push(output)
  }
  gl.transformFeedbackVaryings(program, outputs, gl.SEPARATE_ATTRIBS)
  gl.linkProgram(program)

  const error = gl.getProgramInfoLog(program)
  if (error) throw new Error(error)

  gl.beginTransformFeedback(gl.TRIANGLES)
  this.render(node, _camera)
  gl.endTransformFeedback()

  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null)
  gl.disable(gl.RASTERIZER_DISCARD)
  node.material = oldMaterial
}

THREE.ShaderMaterial.prototype.computeShader = ''

const renderer = new THREE.WebGLRenderer()
renderer.setSize(window.innerWidth, window.innerHeight)
document.body.appendChild(renderer.domElement)

const camera = new THREE.PerspectiveCamera()

const geometry = new THREE.BufferGeometry()
geometry.boundingSphere = new THREE.Sphere().set(new THREE.Vector3(), Infinity)
geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 2))
geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6), 2))

const material = new THREE.RawShaderMaterial({
  computeShader: /* glsl */ `//#version 300 es
    out vec2 uv;
    out vec2 position;

    void main() {
      uv = vec2(gl_VertexID << 1 & 2, gl_VertexID & 2);
      position = uv * 2.0 - 1.0;
    }
  `,
  vertexShader: /* glsl */ `//#version 300 es
    in vec2 uv;
    in vec2 position;
    out vec2 vUv;

    void main() {
      vUv = uv;
      gl_Position = vec4(position, 0, 1);
    }
  `,
  fragmentShader: /* glsl */ `//#version 300 es
    precision lowp float;

    in vec2 vUv;
    out vec4 color;

    void main() {
      color = vec4(vUv, 0, 1);
    }
  `,
  glslVersion: THREE.GLSL3,
})
const mesh = new THREE.Mesh(geometry, material)

renderer.compute(mesh)
renderer.render(mesh, camera)
