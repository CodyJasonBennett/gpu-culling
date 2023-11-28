import * as THREE from 'three'

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
