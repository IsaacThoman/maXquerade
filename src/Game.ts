import * as THREE from 'three'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { StatsOverlay } from './StatsOverlay'
import { Enemy } from './Enemy'
import { BaseOverlayWorld } from './BaseOverlayWorld'
import { HandViewModel } from './HandViewModel'
import { Projectile } from './Projectile'
import { computeBoundsTreeOnce, disposeBoundsTreeIfPresent, initThreeMeshBVH, setRaycasterFirstHitOnly } from './bvh'
import { FrameProfiler } from './FrameProfiler'

type Cleanup = () => void

export function startWalkingSim(root: HTMLElement): Cleanup {
  initThreeMeshBVH()

  root.innerHTML = ''
  root.classList.add('game-root')

  const crosshair = document.createElement('div')
  crosshair.className = 'crosshair'

  // Stats overlay
  const statsOverlay = new StatsOverlay(root, { showVelocity: true, showState: true, showFPS: true, showTimings: true })
  statsOverlay.setVisible(false)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0b1220)
  scene.fog = new THREE.Fog(0x0b1220, 20, 120)

  // Enemies can be either unmasked (always visible) or masked (only visible through mask alpha).
  const unmaskedEnemyScene = new THREE.Scene()
  unmaskedEnemyScene.fog = new THREE.Fog(0x0b1220, 20, 120)

  const maskedEnemyScene = new THREE.Scene()
  maskedEnemyScene.fog = new THREE.Fog(0x0b1220, 20, 120)

  const camera = new THREE.PerspectiveCamera(
    90, // Wider FOV for speed feel
    Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight),
    0.1,
    500,
  )

  const baseOverlayWorld = new BaseOverlayWorld({
    aspect: Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight),
  })

  const handViewModel = new HandViewModel({
    aspect: Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight),
    idleFps: 6,
    throwFps: 12,
  })

  const handIdleFpsMoving = 6
  const handIdleFpsStill = 1
  const handMoveSpeedThreshold = 0.15

  const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.autoClear = false
  renderer.domElement.className = 'game-canvas'
  root.append(renderer.domElement, crosshair)

  // Get WebGL context for stencil operations
  const gl = renderer.getContext()

  const controls = new PointerLockControls(camera, renderer.domElement)
  const player = controls.object
  scene.add(player)

  // Player config
  const playerHeight = 1.7
  const playerRadius = 0.35
  const slideHeight = 0.9 // Crouched/sliding height
  player.position.set(0, playerHeight, 0)

  // Collision meshes from the map
  const collisionMeshes: THREE.Mesh[] = []
  const collisionGeometries = new Set<THREE.BufferGeometry>()

  // Door removal state
  let nextDoorIndex = 1
  let mapRoot: THREE.Group | null = null

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

  // Create enemies (spawn high to let gravity settle)
  // Type 0: always visible
  // Type 1: only visible through mask alpha
  const enemies: Enemy[] = [
    new Enemy(new THREE.Vector3(0, 5.0, -20), 'idle', 0),
    new Enemy(new THREE.Vector3(-3, 5.0, -15), 'idle', 1),
  ]

  const projectiles: Projectile[] = []
  const effects: Projectile[] = []

  const spawnExplosion = (worldPos: THREE.Vector3): void => {
    const fx = new Projectile(worldPos.clone(), new THREE.Vector3(0, 0, 0), {
      spriteSrc: '/sprites/explode_reordered.png',
      frameWidth: 200,
      frameHeight: 282,
      frameCount: 17,
      framesPerRow: 17,
      fps: 24,
      size: 10.0,
      billboard: 'full',
      alphaTest: 0.05,
      gravity: 0,
      drag: 0,
      lifetimeSeconds: 17 / 24,
      collisionRadius: 0,
      collideWithWorld: false,
      maxBounces: 0,
      bounceRestitution: 0,
    })

    scene.add(fx.mesh)
    effects.push(fx)
  }

  for (const e of enemies) {
    if (e.type === 0) unmaskedEnemyScene.add(e.mesh)
    else maskedEnemyScene.add(e.mesh)
  }

  // Load map.glb
  const loader = new GLTFLoader()
  loader.load('/map.glb', (gltf) => {
    const map = gltf.scene
    mapRoot = map
    map.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh
        mesh.castShadow = true
        mesh.receiveShadow = true
        // Add all meshes to collision detection
        collisionMeshes.push(mesh)

        const geometry = mesh.geometry as THREE.BufferGeometry
        collisionGeometries.add(geometry)
        computeBoundsTreeOnce(geometry)
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
  let zDown = false

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
  const up = new THREE.Vector3(0, 1, 0)

  const projectileSpawnPos = new THREE.Vector3()
  const projectileDir = new THREE.Vector3()
  const projectileRight = new THREE.Vector3()
  const spawnKnifeProjectile = () => {
    camera.getWorldDirection(projectileDir)
    projectileDir.normalize()
    projectileRight.crossVectors(projectileDir, up).normalize()

    projectileSpawnPos.copy(camera.position)
    projectileSpawnPos.addScaledVector(projectileDir, 0.75)
    projectileSpawnPos.addScaledVector(projectileRight, 0.18)
    projectileSpawnPos.addScaledVector(up, -0.16)

    const projectileVelocity = new THREE.Vector3()
      .copy(projectileDir)
      .multiplyScalar(32)
      .addScaledVector(velocity, 0.25)

    const p = new Projectile(projectileSpawnPos, projectileVelocity, {
      spriteSrc: '/sprites/knife_projectile.png',
      frameWidth: 32,
      frameHeight: 32,
      frameCount: 4,
      framesPerRow: 2,
      fps: 18,
      size: 1.25,
      billboard: 'upright',
      alphaTest: 0.35,
      gravity: 0,
      drag: 0,
      lifetimeSeconds: 20.0,
      collisionRadius: 0.16,
      collideWithWorld: true,
      bounceRestitution: 0.9,
      maxBounces: 10,
    })

    scene.add(p.mesh)
    projectiles.push(p)
  }

  // Raycasters for collision
  const groundRaycaster = new THREE.Raycaster()
  const wallRaycaster = new THREE.Raycaster()
  groundRaycaster.far = playerHeight + 0.5
  wallRaycaster.far = playerRadius + 0.1
  setRaycasterFirstHitOnly(groundRaycaster, true)
  setRaycasterFirstHitOnly(wallRaycaster, true)

  const groundHits: THREE.Intersection[] = []
  const wallHits: THREE.Intersection[] = []
  const wallDirs = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(0.707, 0, 0.707),
    new THREE.Vector3(-0.707, 0, 0.707),
    new THREE.Vector3(0.707, 0, -0.707),
    new THREE.Vector3(-0.707, 0, -0.707),
  ]

  const isOverlayRotateHeld = () => rightMouseDown || zDown

  const removeNextDoor = () => {
    if (!mapRoot || nextDoorIndex > 5) return
    
    const doorName = `Door${nextDoorIndex}`
    let doorFound = false
    
    mapRoot.traverse((child) => {
      if (doorFound) return
      if (child.name === doorName) {
        // Remove from collision meshes
        child.traverse((descendant) => {
          if ((descendant as THREE.Mesh).isMesh) {
            const mesh = descendant as THREE.Mesh
            const index = collisionMeshes.indexOf(mesh)
            if (index > -1) {
              collisionMeshes.splice(index, 1)
            }
          }
        })
        // Remove from scene
        child.parent?.remove(child)
        doorFound = true
        nextDoorIndex++
      }
    })
  }

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
      case 'KeyZ':
        zDown = true
        frozenCameraQuat.copy(camera.quaternion)
        break
      case 'KeyO':
        removeNextDoor()
        break
      case 'KeyP':
        statsOverlay.toggleVisible()
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
      case 'KeyZ':
        zDown = false
        break
    }
  }

  const onMouseMove = (event: MouseEvent) => {
    baseOverlayWorld.handleMouseMove(event, isOverlayRotateHeld())
  }

  const onMouseDown = (event: MouseEvent) => {
    if (event.button === 0) {
      handViewModel.triggerThrow()
      spawnKnifeProjectile()
      return
    }
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
    baseOverlayWorld.onResize(w, h)
    handViewModel.onResize(w, h)
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
      groundHits.length = 0
      groundRaycaster.intersectObjects(collisionMeshes, false, groundHits)
      if (groundHits.length > 0) {
        const dist = groundHits[0].distance
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

    // Check at multiple heights (feet, waist, head)
    const height0 = 0.2
    const height1 = currentHeight * 0.5
    const height2 = currentHeight - 0.1

    for (let h = 0; h < 3; h++) {
      const height = h === 0 ? height0 : h === 1 ? height1 : height2
      for (const dir of wallDirs) {
        rayOrigin.set(pos.x, pos.y - currentHeight + height, pos.z)
        wallRaycaster.set(rayOrigin, dir)
        wallRaycaster.far = playerRadius + 0.05

        wallHits.length = 0
        wallRaycaster.intersectObjects(collisionMeshes, false, wallHits)
        if (wallHits.length > 0) {
          const hit = wallHits[0]
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
  const frameProfiler = new FrameProfiler({ windowSize: 60 })
  let raf = 0
  let lastFrameStart = 0

  // FPS tracking
  let frameCount = 0
  let fpsUpdateTime = 0
  let currentFPS = 0

  const animate = () => {
    raf = window.requestAnimationFrame(animate)
    const frameStart = performance.now()
    const rafDtMs = lastFrameStart === 0 ? 0 : frameStart - lastFrameStart
    lastFrameStart = frameStart
    const dt = Math.min(0.05, clock.getDelta())

    // FPS calculation
    frameCount++
    fpsUpdateTime += dt
    if (fpsUpdateTime >= 0.5) {
      currentFPS = frameCount / fpsUpdateTime
      frameCount = 0
      fpsUpdateTime = 0
    }

    if (isOverlayRotateHeld()) {
      camera.quaternion.copy(frozenCameraQuat)
      camera.updateMatrixWorld()
    }

    let playerMs: number | null = null

    if (controls.isLocked) {
      const playerStart = performance.now()
      // Get camera-relative directions (THE FIX for world-relative controls)
      camera.getWorldDirection(forward)
      forward.y = 0
      forward.normalize()
      right.crossVectors(forward, up).normalize()

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

      playerMs = performance.now() - playerStart
    }

    // Always update enemy physics
    const enemyStart = performance.now()
    for (const e of enemies) {
      e.update({
        dt,
        camera,
        playerPosition: player.position,
        collisionMeshes,
      })

      if (e.consumeExplosionEvent()) {
        spawnExplosion(e.mesh.position)
      }
    }
    const enemyMs = performance.now() - enemyStart

    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i]
      p.update({ dt, camera, collisionMeshes })

      // Projectile vs enemy collision
      if (p.alive) {
        const px = p.mesh.position.x
        const py = p.mesh.position.y
        const pz = p.mesh.position.z

        for (let j = enemies.length - 1; j >= 0; j--) {
          const e = enemies[j]
          if (!e.isHittable) continue

          const ex = e.mesh.position.x
          const ey = e.mesh.position.y
          const ez = e.mesh.position.z

          const dx = px - ex
          const dz = pz - ez
          const r = e.hitRadius + p.collisionRadius
          if (dx * dx + dz * dz > r * r) continue

          const dy = Math.abs(py - ey)
          if (dy > e.halfHeight + p.collisionRadius) continue

          // Hit!
          p.alive = false
          e.kill()

          if (e.type !== 0) {
            // No death animation: explode immediately.
            spawnExplosion(e.mesh.position)

            // For now, non-type-0 enemies just disappear.
            maskedEnemyScene.remove(e.mesh)
            e.dispose()
            enemies.splice(j, 1)
          }

          break
        }
      }

      if (!p.alive) {
        scene.remove(p.mesh)
        p.dispose()
        projectiles.splice(i, 1)
      }
    }

    for (let i = effects.length - 1; i >= 0; i--) {
      const fx = effects[i]
      fx.update({ dt, camera })
      if (!fx.alive) {
        scene.remove(fx.mesh)
        fx.dispose()
        effects.splice(i, 1)
      }
    }

    const overlayStart = performance.now()
    baseOverlayWorld.update(dt, !isOverlayRotateHeld())

    const handHorizontalSpeed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z)
    const handIsMoving = controls.isLocked && handHorizontalSpeed > handMoveSpeedThreshold
    handViewModel.idleFps = handIsMoving ? handIdleFpsMoving : handIdleFpsStill
    handViewModel.update(dt)
    const overlayMs = performance.now() - overlayStart

    // === MULTI-PASS RENDERING WITH STENCIL MASKING ===
    // Type 0 enemies are visible normally; type 1 enemies are only visible through the mask alpha.
    
    // Pass 1: Clear everything and render the world (map, environment)
    const renderWorldStart = performance.now()
    renderer.clear(true, true, true) // color, depth, stencil
    renderer.render(scene, camera)
    const renderWorldMs = performance.now() - renderWorldStart

    // Pass 1b: Render unmasked enemies normally (no stencil)
    const renderEnemiesUnmaskedStart = performance.now()
    renderer.render(unmaskedEnemyScene, camera)
    const renderEnemiesUnmaskedMs = performance.now() - renderEnemiesUnmaskedStart
    
    // Pass 2: Render alpha mask to STENCIL BUFFER ONLY (eye holes)
    // Configure stencil: write 1 where alpha mask is drawn
    const renderMaskStart = performance.now()
    gl.enable(gl.STENCIL_TEST)
    gl.stencilFunc(gl.ALWAYS, 1, 0xff)
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE)
    gl.colorMask(false, false, false, false) // Don't write to color buffer
    gl.depthMask(false) // Don't write to depth buffer

    renderer.render(baseOverlayWorld.alphaMaskScene, baseOverlayWorld.alphaMaskCamera)
    const renderMaskMs = performance.now() - renderMaskStart
    
    // Pass 3: Render masked enemies ONLY where stencil == 1 (eye holes)
    const renderEnemiesMaskedStart = performance.now()
    gl.stencilFunc(gl.EQUAL, 1, 0xff)
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP)
    gl.colorMask(true, true, true, true) // Write to color buffer
    gl.depthMask(true) // Write to depth buffer

    renderer.render(maskedEnemyScene, camera)

    // Disable stencil for the rest
    gl.disable(gl.STENCIL_TEST)
    const renderEnemiesMaskedMs = performance.now() - renderEnemiesMaskedStart
    
    // Pass 4: Render hand viewmodel (beneath mask overlay)
    const renderHandStart = performance.now()
    renderer.clearDepth()
    renderer.render(handViewModel.scene, handViewModel.camera)
    const renderHandMs = performance.now() - renderHandStart

    // Pass 5: Render the mask overlay on top of everything
    const renderOverlayStart = performance.now()
    renderer.clearDepth()
    renderer.render(baseOverlayWorld.scene, baseOverlayWorld.camera)
    const renderOverlayMs = performance.now() - renderOverlayStart

    const renderMs = renderWorldMs + renderEnemiesUnmaskedMs + renderMaskMs + renderEnemiesMaskedMs + renderOverlayMs + renderHandMs
    const frameMs = performance.now() - frameStart
    const physicsMs = (playerMs ?? 0) + enemyMs

    frameProfiler.add('frame', frameMs)
    frameProfiler.add('raf', rafDtMs)
    frameProfiler.add('physics', physicsMs)
    if (playerMs !== null) frameProfiler.add('player', playerMs)
    frameProfiler.add('enemy', enemyMs)
    frameProfiler.add('overlay', overlayMs)
    frameProfiler.add('render', renderMs)
    frameProfiler.add('render.world', renderWorldMs)
    frameProfiler.add('render.enemies', renderEnemiesUnmaskedMs + renderEnemiesMaskedMs)
    frameProfiler.add('render.enemies.unmasked', renderEnemiesUnmaskedMs)
    frameProfiler.add('render.mask', renderMaskMs)
    frameProfiler.add('render.enemies.masked', renderEnemiesMaskedMs)
    frameProfiler.add('render.overlay', renderOverlayMs)
    frameProfiler.add('render.hand', renderHandMs)

    if (controls.isLocked && statsOverlay.isVisible()) {
      // Update stats overlay (with rolling averages)
      statsOverlay.update({
        position: player.position,
        velocity: velocity,
        grounded: grounded,
        sliding: sliding,
        fps: currentFPS,
        timings: frameProfiler.snapshot(),
      })
    }
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

    for (const geometry of collisionGeometries) {
      disposeBoundsTreeIfPresent(geometry)
    }

     for (const e of enemies) e.dispose()
      for (const p of projectiles) {
        scene.remove(p.mesh)
        p.dispose()
      }
      for (const fx of effects) {
        scene.remove(fx.mesh)
        fx.dispose()
      }
      baseOverlayWorld.dispose()
      handViewModel.dispose()
      statsOverlay.destroy()
      renderer.dispose()
      root.innerHTML = ''
   }
}
