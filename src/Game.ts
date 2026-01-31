import * as THREE from 'three'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { StatsOverlay } from './StatsOverlay'
import { Enemy } from './Enemy'
import { SpriteSheet } from './SpriteSheet'

type Cleanup = () => void

export function startWalkingSim(root: HTMLElement): Cleanup {
  root.innerHTML = ''
  root.classList.add('game-root')

  const crosshair = document.createElement('div')
  crosshair.className = 'crosshair'

  // Stats overlay
  const statsOverlay = new StatsOverlay(root, { showVelocity: true, showState: true })

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0b1220)
  scene.fog = new THREE.Fog(0x0b1220, 20, 120)

  const overlayScene = new THREE.Scene()

  const camera = new THREE.PerspectiveCamera(
    90, // Wider FOV for speed feel
    Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight),
    0.1,
    500,
  )

  const overlayCamera = new THREE.PerspectiveCamera(
    45,
    Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight),
    0.1,
    50,
  )
  overlayCamera.position.set(0, 0, 2.4)

  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.autoClear = false
  renderer.domElement.className = 'game-canvas'
 // root.append(renderer.domElement, crosshair)

  const controls = new PointerLockControls(camera, renderer.domElement)
  const player = controls.object
  scene.add(player)

  const overlayPlaneGeometry = new THREE.PlaneGeometry(1, 1)
  const overlayPlaneMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
  })
  const overlayPlane = new THREE.Mesh(overlayPlaneGeometry, overlayPlaneMaterial)
  overlayScene.add(overlayPlane)

  let overlayTexture: THREE.CanvasTexture | null = null
  let overlayCanvas: HTMLCanvasElement | null = null
  let overlayCtx: CanvasRenderingContext2D | null = null
  let overlayBaseImage: HTMLImageElement | null = null
  let overlayAnim: SpriteSheet | null = null
  let overlayAnimX = 0
  let overlayAnimY = 0
  let overlayAnimScale = 1
  let overlayAnimFrame = 0
  let overlayAnimTimer = 0
  const overlayAnimFps = 8

  const loadImage = (src: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.decoding = 'async'
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`Failed to load image: ${src}`))
      img.src = src
    })

  const renderOverlay = (dt: number) => {
    if (!overlayCanvas || !overlayCtx || !overlayBaseImage || !overlayAnim || !overlayTexture) return
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)
    overlayCtx.drawImage(overlayBaseImage, 0, 0)
    if (overlayAnim.frameCount > 1 && overlayAnimFps > 0) {
      const frameDuration = 1 / overlayAnimFps
      overlayAnimTimer += dt
      while (overlayAnimTimer >= frameDuration) {
        overlayAnimTimer -= frameDuration
        overlayAnimFrame = (overlayAnimFrame + 1) % overlayAnim.frameCount
      }
    }
    overlayAnim.drawFrame(overlayCtx, overlayAnimFrame, overlayAnimX, overlayAnimY, overlayAnimScale)
    overlayTexture.needsUpdate = true
  }

  Promise.all([loadImage('/sprites/mask0.png'), loadImage('/sprites/mask1.png')])
    .then(([baseImage, animImage]) => {
      overlayBaseImage = baseImage
      overlayCanvas = document.createElement('canvas')
      overlayCanvas.width = baseImage.width
      overlayCanvas.height = baseImage.height
      overlayCtx = overlayCanvas.getContext('2d')
      if (!overlayCtx) return
      overlayCtx.imageSmoothingEnabled = false

      overlayTexture = new THREE.CanvasTexture(overlayCanvas)
      overlayTexture.magFilter = THREE.NearestFilter
      overlayTexture.minFilter = THREE.NearestFilter
      overlayTexture.generateMipmaps = false

      overlayPlaneMaterial.map = overlayTexture
      overlayPlaneMaterial.needsUpdate = true

      const aspect = overlayCanvas.width / overlayCanvas.height
      overlayPlane.scale.set(aspect, 1, 1)

      overlayAnim = new SpriteSheet(animImage, 64, 48, {
        frameCount: 4,
        framesPerRow: 1,
      })

      overlayAnimX = Math.floor((overlayCanvas.width - overlayAnim.frameWidth * overlayAnimScale) / 2)
      overlayAnimY = Math.floor((overlayCanvas.height - overlayAnim.frameHeight * overlayAnimScale) / 2)

      renderOverlay(0)
    })
    .catch((error) => {
      console.error(error)
    })

  // Player config
  const playerHeight = 1.7
  const playerRadius = 0.35
  const slideHeight = 0.9 // Crouched/sliding height
  player.position.set(0, playerHeight, 0)

  // Collision meshes from the map
  const collisionMeshes: THREE.Mesh[] = []

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

// Create enemy at specified position with pursuing state (spawn high to let gravity settle)
  const enemy = new Enemy(new THREE.Vector3(-5.42, 5.0, -5.07), 'idle')
  scene.add(enemy.mesh)

  // Load map.glb
  const loader = new GLTFLoader()
  loader.load('/map.glb', (gltf) => {
    const map = gltf.scene
    map.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh
        mesh.castShadow = true
        mesh.receiveShadow = true
        // Add all meshes to collision detection
        collisionMeshes.push(mesh)
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
  let wantCrouch = false
  let rightMouseDown = false

  // Physics state
  const velocity = new THREE.Vector3()
  let grounded = true
  let sliding = false
  let slideTimer = 0
  let currentHeight = playerHeight

  // Tuning - FAST AND SNAPPY
  const walkSpeed = 12
  const sprintSpeed = 20
  const slideSpeed = 28 // Initial slide speed
  const slideMinSpeed = 8 // Minimum speed to maintain slide
  const slideDuration = 0.8 // Max slide time
  const slideFriction = 4 // Lower = longer slides
  const airSpeed = 4
  const groundAccel = 80 // Snappy acceleration
  const airAccel = 35 // Good air control
  const friction = 12
  const gravity = 32
  const jumpVelocity = 11
  const slideJumpBoost = 1.4 // Momentum multiplier when slide-jumping
  const coyoteTime = 0.15
  const jumpBufferTime = 0.15

  let timeSinceGrounded = 0
  let jumpBuffered = 0

  // Reusable vectors for performance
  const forward = new THREE.Vector3()
  const right = new THREE.Vector3()
  const wishDir = new THREE.Vector3()
  const rayOrigin = new THREE.Vector3()
  const rayDir = new THREE.Vector3()
  const frozenCameraQuat = new THREE.Quaternion()
  const overlayEuler = new THREE.Euler(0, 0, 0, 'YXZ')
  let overlayYaw = 0
  let overlayPitch = 0

  // Raycasters for collision
  const groundRaycaster = new THREE.Raycaster()
  const wallRaycaster = new THREE.Raycaster()
  groundRaycaster.far = playerHeight + 0.5
  wallRaycaster.far = playerRadius + 0.1

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
      case 'KeyC':
      case 'ControlLeft':
      case 'ControlRight':
        wantCrouch = true
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
      case 'KeyC':
      case 'ControlLeft':
      case 'ControlRight':
        wantCrouch = false
        break
    }
  }

  const updateOverlayCamera = () => {
    overlayEuler.set(overlayPitch, overlayYaw, 0)
    overlayCamera.quaternion.setFromEuler(overlayEuler)
  }

  updateOverlayCamera()

  const onMouseMove = (event: MouseEvent) => {
    if (!rightMouseDown) return
    const movementX = event.movementX || 0
    const movementY = event.movementY || 0
    const sensitivity = 0.0025

    overlayYaw -= movementX * sensitivity
    overlayPitch -= movementY * sensitivity

    const maxPitch = Math.PI * 0.49
    overlayPitch = Math.max(-maxPitch, Math.min(maxPitch, overlayPitch))
    updateOverlayCamera()
  }

  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 2) return
    rightMouseDown = true
    frozenCameraQuat.copy(camera.quaternion)
  }

  const onMouseUp = (event: MouseEvent) => {
    if (event.button !== 2) return
    rightMouseDown = false
  }

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault()
  }

  // Auto-lock on click
  const autoLock = () => {
    controls.lock()
  }
  document.addEventListener('click', autoLock)

  const onResize = () => {
    const w = Math.max(1, window.innerWidth)
    const h = Math.max(1, window.innerHeight)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    overlayCamera.aspect = w / h
    overlayCamera.updateProjectionMatrix()
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  }

  // Ground raycast check
  function checkGround(pos: THREE.Vector3): { grounded: boolean; groundY: number } {
    rayOrigin.set(pos.x, pos.y, pos.z)
    rayDir.set(0, -1, 0)
    groundRaycaster.set(rayOrigin, rayDir)

    // Check map collision
    if (collisionMeshes.length > 0) {
      const hits = groundRaycaster.intersectObjects(collisionMeshes, false)
      if (hits.length > 0) {
        const dist = hits[0].distance
        if (dist <= currentHeight + 0.1) {
          return { grounded: true, groundY: pos.y - dist }
        }
      }
    }

    // Fallback to y=0 floor
    if (pos.y <= currentHeight + 0.1) {
      return { grounded: true, groundY: 0 }
    }

    return { grounded: false, groundY: 0 }
  }

  // Wall collision - push player out of walls
  function resolveWallCollision(pos: THREE.Vector3, vel: THREE.Vector3): void {
    if (collisionMeshes.length === 0) return

    // Check 8 directions around player
    const directions = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(0.707, 0, 0.707),
      new THREE.Vector3(-0.707, 0, 0.707),
      new THREE.Vector3(0.707, 0, -0.707),
      new THREE.Vector3(-0.707, 0, -0.707),
    ]

    // Check at multiple heights (feet, waist, head)
    const heights = [0.2, currentHeight * 0.5, currentHeight - 0.1]

    for (const height of heights) {
      for (const dir of directions) {
        rayOrigin.set(pos.x, pos.y - currentHeight + height, pos.z)
        wallRaycaster.set(rayOrigin, dir)
        wallRaycaster.far = playerRadius + 0.05

        const hits = wallRaycaster.intersectObjects(collisionMeshes, false)
        if (hits.length > 0) {
          const hit = hits[0]
          const penetration = playerRadius - hit.distance + 0.01
          if (penetration > 0) {
            // Push player out
            pos.x -= dir.x * penetration
            pos.z -= dir.z * penetration

            // Kill velocity into the wall
            const velDot = vel.x * dir.x + vel.z * dir.z
            if (velDot > 0) {
              vel.x -= dir.x * velDot
              vel.z -= dir.z * velDot
            }
          }
        }
      }
    }
  }

  const clock = new THREE.Clock()
  let raf = 0

  const animate = () => {
    raf = window.requestAnimationFrame(animate)
    const dt = Math.min(0.05, clock.getDelta())

    if (rightMouseDown) {
      camera.quaternion.copy(frozenCameraQuat)
      camera.updateMatrixWorld()
    }

    if (controls.isLocked) {
      // Get camera-relative directions (THE FIX for world-relative controls)
      camera.getWorldDirection(forward)
      forward.y = 0
      forward.normalize()
      right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize()

      // Ground check
      const groundCheck = checkGround(player.position)
      grounded = groundCheck.grounded

      if (grounded) {
        timeSinceGrounded = 0
        const targetY = groundCheck.groundY + currentHeight
        if (player.position.y < targetY) {
          player.position.y = targetY
          if (velocity.y < 0) velocity.y = 0
        }
      } else {
        timeSinceGrounded += dt
      }

      // Jump buffer countdown
      if (jumpBuffered > 0) jumpBuffered -= dt

      // Slide logic - CoD style
      const horizontalSpeed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z)

      // Start slide: sprinting + crouch + grounded + fast enough
      if (wantCrouch && sprinting && grounded && !sliding && horizontalSpeed > walkSpeed) {
        sliding = true
        slideTimer = slideDuration
        // Boost to slide speed in current direction
        if (horizontalSpeed > 0) {
          const speedMultiplier = slideSpeed / horizontalSpeed
          velocity.x *= speedMultiplier
          velocity.z *= speedMultiplier
        }
      }

      // Continue or end slide
      if (sliding) {
        slideTimer -= dt

        // End slide conditions
        if (!wantCrouch || slideTimer <= 0 || horizontalSpeed < slideMinSpeed || !grounded) {
          sliding = false
          slideTimer = 0
        }
      }

      // Smooth height transition
      const targetHeight = sliding ? slideHeight : playerHeight
      currentHeight = THREE.MathUtils.lerp(currentHeight, targetHeight, 1 - Math.pow(0.001, dt))

      // Coyote time jump
      const canJump = grounded || timeSinceGrounded < coyoteTime
      if ((wantJump || jumpBuffered > 0) && canJump && velocity.y <= 0.1) {
        // Slide jump boost!
        if (sliding) {
          velocity.y = jumpVelocity * slideJumpBoost
          // Maintain horizontal momentum
          velocity.x *= slideJumpBoost
          velocity.z *= slideJumpBoost
        } else {
          velocity.y = jumpVelocity
        }
        grounded = false
        sliding = false
        timeSinceGrounded = coyoteTime // consume coyote
        jumpBuffered = 0
      }

      // Build input direction - CAMERA RELATIVE
      wishDir.set(0, 0, 0)
      if (moveForward) wishDir.add(forward)
      if (moveBackward) wishDir.sub(forward)
      if (moveRight) wishDir.add(right)
      if (moveLeft) wishDir.sub(right)
      wishDir.normalize()

      // Determine max speed and acceleration
      let maxSpeed: number
      let accel: number

      if (!grounded) {
        maxSpeed = airSpeed
        accel = airAccel
      } else if (sliding) {
        // Sliding - reduced control, gradual slowdown
        maxSpeed = slideSpeed
        accel = groundAccel * 0.2 // Minimal steering while sliding
      } else {
        maxSpeed = sprinting ? sprintSpeed : walkSpeed
        accel = groundAccel
      }

      // Apply friction (not while sliding much)
      if (grounded && !sliding) {
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
      } else if (sliding) {
        // Light slide friction
        const speed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z)
        if (speed > 0.1) {
          const drop = speed * slideFriction * dt
          const scale = Math.max(speed - drop, 0) / speed
          velocity.x *= scale
          velocity.z *= scale
        }
      }

      // Accelerate
      if (wishDir.lengthSq() > 0 && !sliding) {
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

      // Wall collision resolution
      resolveWallCollision(player.position, velocity)

      // Final ground clamp
      const finalGround = checkGround(player.position)
      if (finalGround.grounded) {
        const targetY = finalGround.groundY + currentHeight
        if (player.position.y < targetY) {
          player.position.y = targetY
          if (velocity.y < 0) velocity.y = 0
          grounded = true
        }
      }

      // Fallback floor
      if (player.position.y < currentHeight) {
        player.position.y = currentHeight
        if (velocity.y < 0) velocity.y = 0
        grounded = true
      }

      // Dynamic FOV based on speed (subtle and snappy)
      const speed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z)
      const targetFOV = 90 + Math.min(speed * 0.1, 6) // Up to 96 FOV at high speed
      camera.fov = THREE.MathUtils.lerp(camera.fov, targetFOV, 1 - Math.pow(0.0001, dt))
      camera.updateProjectionMatrix()

      // Update stats overlay
      statsOverlay.update({
        position: player.position,
        velocity: velocity,
        grounded: grounded,
        sliding: sliding,
      })
    }

    // Always update enemy physics
    enemy.update({
      dt,
      camera,
      playerPosition: player.position,
      collisionMeshes,
    })

    renderOverlay(dt)

    renderer.clear()
    renderer.render(scene, camera)
    renderer.clearDepth()
    renderer.render(overlayScene, overlayCamera)
  }
  animate()

  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('keyup', onKeyUp)
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mousedown', onMouseDown)
  document.addEventListener('mouseup', onMouseUp)
  document.addEventListener('contextmenu', onContextMenu)
  window.addEventListener('resize', onResize)

  return () => {
    window.cancelAnimationFrame(raf)
    window.removeEventListener('resize', onResize)
    document.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('keyup', onKeyUp)
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mousedown', onMouseDown)
    document.removeEventListener('mouseup', onMouseUp)
    document.removeEventListener('contextmenu', onContextMenu)
    document.removeEventListener('click', autoLock)

    enemy.dispose()
    overlayTexture?.dispose()
    overlayPlaneMaterial.dispose()
    overlayPlaneGeometry.dispose()
    statsOverlay.destroy()
    renderer.dispose()
    root.innerHTML = ''
  }
}
