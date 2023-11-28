export * from './three.module.js'
import * as THREE from './three.module.js'

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

  // Force reset uniforms after relink
  for (const uniform of materialProperties.uniformsList) {
    uniform.addr = gl.getUniformLocation(program, uniform.id)
    uniform.cache = []
  }

  const error = gl.getProgramInfoLog(program)
  if (error) throw new Error(error)

  gl.beginTransformFeedback(gl.TRIANGLES)
  this.render(node, _camera)
  gl.endTransformFeedback()

  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null)
  gl.disable(gl.RASTERIZER_DISCARD)
  node.material = oldMaterial

  // Debug CPU readback
  for (const output of outputs) {
    const attribute = node.geometry.attributes[output]
    const { buffer } = this.attributes.get(attribute)

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.getBufferSubData(gl.ARRAY_BUFFER, 0, attribute.array)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)

    console.log(output, Array.from(attribute.array))
  }
}

THREE.ShaderMaterial.prototype.computeShader = ''
