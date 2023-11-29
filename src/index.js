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
  // for (const output of compiled.outputs) {
  //   const attribute = node.geometry.attributes[output]
  //   const { buffer } = this.attributes.get(attribute)

  //   gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  //   gl.getBufferSubData(gl.ARRAY_BUFFER, 0, attribute.array)
  //   gl.bindBuffer(gl.ARRAY_BUFFER, null)

  //   console.log(output, Array.from(attribute.array))
  // }
}

THREE.ShaderMaterial.prototype.computeShader = ''

const renderer = new THREE.WebGLRenderer()
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
geometry.setAttribute('visibility', new THREE.BufferAttribute(new Int32Array(3), 1))
geometry.attributes.visibility.gpuType = THREE.IntType

const projectionViewMatrix = new THREE.Matrix4()

const material = new THREE.RawShaderMaterial({
  uniforms: {
    projectionViewMatrix: new THREE.Uniform(projectionViewMatrix),
  },
  computeShader: /* glsl */ `//#version 300 es
    uniform mat4 projectionViewMatrix;

    flat out int visibility;

    const float radius = 0.5;
    const vec4 position = vec4(0, 0, 0, 1);

    void main() {
      // http://cs.otago.ac.nz/postgrads/alexis/planeExtraction.pdf
      vec4 planes[] = vec4[](
        projectionViewMatrix[3] - projectionViewMatrix[0], // left   (-w < +x)
        projectionViewMatrix[3] + projectionViewMatrix[0], // right  (+x < +w)
        projectionViewMatrix[3] - projectionViewMatrix[1], // bottom (-w < +y)
        projectionViewMatrix[3] + projectionViewMatrix[1], // top    (+y < +w)
        projectionViewMatrix[3] - projectionViewMatrix[2], // near   (-w < +z)
        projectionViewMatrix[3] + projectionViewMatrix[2]  // far    (+z < +w)
      );

      visibility = 0;
      for (int i = 0; i < 6; i++) {
        float distance = dot(planes[i], position);
        if (distance <= -radius) {
          visibility = 2;
          break;
        }
      }
    }
  `,
  vertexShader: /* glsl */ `//#version 300 es
    out vec2 vUv;
    in int visibility;

    void main() {
      vUv = vec2(gl_VertexID << 1 & 2, gl_VertexID & 2);
      gl_Position = vec4(vUv * 2.0 - 1.0, visibility, 1);
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
scene.add(mesh)

scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshNormalMaterial()))

const onResize = () => {
  renderer.setSize(window.innerWidth, window.innerHeight)
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
}
onResize()
window.addEventListener('resize', onResize)

const frustum = new THREE.Frustum()

renderer.setAnimationLoop(() => {
  controls.update()

  camera.updateWorldMatrix()
  projectionViewMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)

  frustum.setFromProjectionMatrix(projectionViewMatrix)
  console.log(frustum.intersectsObject(scene.children[1]))

  renderer.compute(mesh)
  renderer.render(scene, camera)
})
