import * as THREE from 'three'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

type Cleanup = () => void

export function startWalkingSim(root: HTMLElement): Cleanup {
  root.innerHTML = ''
  root.classList.add('game-root')

  const crosshair = document.createElement('div')
  crosshair.className = 'crosshair'

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0b1220)
  scene.fog = new THREE.Fog(0x0b1220, 20, 120)

  const camera = new THREE.PerspectiveCamera(
    80,
    Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight),
    0.1,
    500,
  )

  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.domElement.className = 'game-canvas'
  root.append(renderer.domElement, crosshair)

  const controls = new PointerLockControls(camera, renderer.domElement)
  const player = controls.object
  scene.add(player)

  // Player config
  const playerHeight = 1.7
  player.position.set(0, playerHeight, 0)

  // Lighting
  const hemi = new THREE.HemisphereLight(0xbad2ff, 0x141118, 0.9)
  scene.add(hemi)

  const sun = new THREE.DirectionalLight(0xffffff, 1.2)
  sun.position.set(30, 50, 20)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.near = 1
  sun.shadow.camera.far = 200
  sun.shadow.camera.left = -80
  sun.shadow.camera.right = 80
  sun.shadow.camera.top = 80
  sun.shadow.camera.bottom = -80
  scene.add(sun)

  // Load map.glb
  const loader = new GLTFLoader()
  loader.load('/map.glb', (gltf) => {
    const map = gltf.scene
    map.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true
        child.receiveShadow = true
      }
    })
    scene.add(map)
  })

  // Input state
  let moveForward = false
  let moveBackward = false
  let moveLeft = false
  let moveRight = false
  let wantJump = false
  let sprinting = false

  // Physics state
  const velocity = new THREE.Vector3()
  const inputDir = new THREE.Vector3()
  const wishDir = new THREE.Vector3()
  let grounded = true

  // Tuning - feels snappy and responsive
  const walkSpeed = 8
  const sprintSpeed = 14
  const airSpeed = 2.5
  const groundAccel = 50
  const airAccel = 20
  const friction = 10
  const gravity = 28
  const jumpVelocity = 9
  const coyoteTime = 0.12
  const jumpBufferTime = 0.1

  let timeSinceGrounded = 0
  let jumpBuffered = 0

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat) return
    switch (event.code) {
      case 'KeyW':
      case 'ArrowUp':
        moveForward = true
        break
      case 'KeyS':
      case 'ArrowDown':
        moveBackward = true
        break
      case 'KeyA':
      case 'ArrowLeft':
        moveLeft = true
        break
      case 'KeyD':
      case 'ArrowRight':
        moveRight = true
        break
      case 'Space':
        wantJump = true
        jumpBuffered = jumpBufferTime
        break
      case 'ShiftLeft':
      case 'ShiftRight':
        sprinting = true
        break
    }
  }

  const onKeyUp = (event: KeyboardEvent) => {
    switch (event.code) {
      case 'KeyW':
      case 'ArrowUp':
        moveForward = false
        break
      case 'KeyS':
      case 'ArrowDown':
        moveBackward = false
        break
      case 'KeyA':
      case 'ArrowLeft':
        moveLeft = false
        break
      case 'KeyD':
      case 'ArrowRight':
        moveRight = false
        break
      case 'Space':
        wantJump = false
        break
      case 'ShiftLeft':
      case 'ShiftRight':
        sprinting = false
        break
    }
  }

  // Auto-lock on click (re-locks after Esc too)
  const autoLock = () => {
    controls.lock()
  }
  document.addEventListener('click', autoLock)

  const onResize = () => {
    const w = Math.max(1, window.innerWidth)
    const h = Math.max(1, window.innerHeight)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  }

  // Simple ground check (flat floor at y=0 for now; can raycasts if map has geometry)
  const groundY = 0

  const clock = new THREE.Clock()
  let raf = 0

  const animate = () => {
    raf = window.requestAnimationFrame(animate)
    const dt = Math.min(0.05, clock.getDelta())

    if (controls.isLocked) {
      // Ground check
      grounded = player.position.y <= groundY + playerHeight + 0.05

      if (grounded) {
        timeSinceGrounded = 0
        if (player.position.y < groundY + playerHeight) {
          player.position.y = groundY + playerHeight
          velocity.y = 0
        }
      } else {
        timeSinceGrounded += dt
      }

      // Jump buffer countdown
      if (jumpBuffered > 0) jumpBuffered -= dt

      // Coyote time jump
      const canJump = grounded || timeSinceGrounded < coyoteTime
      if ((wantJump || jumpBuffered > 0) && canJump && velocity.y <= 0.1) {
        velocity.y = jumpVelocity
        grounded = false
        timeSinceGrounded = coyoteTime // consume coyote
        jumpBuffered = 0
      }

      // Build input direction (local space)
      inputDir.set(0, 0, 0)
      if (moveForward) inputDir.z -= 1
      if (moveBackward) inputDir.z += 1
      if (moveRight) inputDir.x += 1
      if (moveLeft) inputDir.x -= 1
      inputDir.normalize()

      // Transform to world space (only yaw)
      const euler = new THREE.Euler(0, camera.rotation.y, 0, 'YXZ')
      wishDir.copy(inputDir).applyEuler(euler)

      const maxSpeed = grounded ? (sprinting ? sprintSpeed : walkSpeed) : airSpeed
      const accel = grounded ? groundAccel : airAccel

      if (grounded) {
        // Apply friction
        const speed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z)
        if (speed > 0.1) {
          const drop = speed * friction * dt
          const scale = Math.max(speed - drop, 0) / speed
          velocity.x *= scale
          velocity.z *= scale
        } else {
          velocity.x = 0
          velocity.z = 0
        }
      }

      // Accelerate
      if (wishDir.lengthSq() > 0) {
        const currentSpeed = velocity.x * wishDir.x + velocity.z * wishDir.z
        const addSpeed = Math.max(0, maxSpeed - currentSpeed)
        const accelAmount = Math.min(accel * dt * maxSpeed, addSpeed)
        velocity.x += wishDir.x * accelAmount
        velocity.z += wishDir.z * accelAmount
      }

      // Gravity
      if (!grounded) {
        velocity.y -= gravity * dt
      }

      // Move
      player.position.x += velocity.x * dt
      player.position.z += velocity.z * dt
      player.position.y += velocity.y * dt

      // Clamp to ground
      if (player.position.y < groundY + playerHeight) {
        player.position.y = groundY + playerHeight
        velocity.y = 0
        grounded = true
      }
    }

    renderer.render(scene, camera)
  }
  animate()

  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('keyup', onKeyUp)
  window.addEventListener('resize', onResize)

  return () => {
    window.cancelAnimationFrame(raf)
    window.removeEventListener('resize', onResize)
    document.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('keyup', onKeyUp)
    document.removeEventListener('click', autoLock)

    renderer.dispose()
    root.innerHTML = ''
  }
}
