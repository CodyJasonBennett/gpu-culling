import * as THREE from 'three'

const renderer = new THREE.WebGLRenderer()
renderer.setSize(window.innerWidth, window.innerHeight)
document.body.appendChild(renderer.domElement)

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight)
camera.position.z = -5
camera.updateWorldMatrix()

const geometry = new THREE.BufferGeometry()
geometry.setDrawRange(0, 3)
geometry.boundingSphere = new THREE.Sphere().set(new THREE.Vector3(), Infinity)
geometry.setAttribute('visibility', new THREE.BufferAttribute(new Int32Array(3), 1))
geometry.attributes.visibility.gpuType = THREE.IntType

const material = new THREE.RawShaderMaterial({
  uniforms: {
    projectionViewMatrix: new THREE.Uniform(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    ),
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
      color = vec4(vUv, 0, 1);
    }
  `,
  glslVersion: THREE.GLSL3,
})
const mesh = new THREE.Mesh(geometry, material)

renderer.compute(mesh)
renderer.render(mesh, camera)
