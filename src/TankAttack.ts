import * as THREE from 'three'
import { SpriteSheet } from './SpriteSheet'
import { setRaycasterFirstHitOnly } from './bvh'

type TankAttackUpdateParams = {
  dt: number
  camera: THREE.Camera
}

export class TankAttack {
  readonly meshes: THREE.Mesh[] = []
  readonly particleCount = 50 // Many more particles for thick line
  
  alive = true
  ageSeconds = 0
  buildDuration = 1 // Build much faster
  particleSize = 0.5 // Bigger particles for visibility

  private hasDamagedPlayer = false
  
  private sheet: SpriteSheet | null = null
  private spriteReady = false
  
  private readonly startPos = new THREE.Vector3()
  private targetPos = new THREE.Vector3() // Made mutable for wall collision
  private readonly direction = new THREE.Vector3()
  private readonly cameraPos = new THREE.Vector3()
  private readonly tmp = new THREE.Vector3()
  private readonly tmp2 = new THREE.Vector3()
  private actualDistance = 0 // Distance to wall or original target
  private collisionMeshes: THREE.Mesh[] = []
  private readonly raycaster = new THREE.Raycaster()
  
  constructor(startPos: THREE.Vector3, targetPos: THREE.Vector3, collisionMeshes: THREE.Mesh[] = []) {
    this.startPos.copy(startPos)
    this.targetPos.copy(targetPos)
    this.direction.subVectors(targetPos, startPos).normalize()
    this.collisionMeshes = collisionMeshes
    setRaycasterFirstHitOnly(this.raycaster, true)
    
    // Calculate actual distance to wall
    this.calculateWallDistance()
    
    // Create particle meshes - each gets its own texture
    for (let i = 0; i < this.particleCount; i++) {
      const geometry = new THREE.PlaneGeometry(this.particleSize, this.particleSize)
      
      // Create individual texture for each particle
      const particleCanvas = document.createElement('canvas')
      particleCanvas.width = 16
      particleCanvas.height = 16
      const particleCtx = particleCanvas.getContext('2d')!
      particleCtx.imageSmoothingEnabled = false
      
      const particleTexture = new THREE.CanvasTexture(particleCanvas)
      particleTexture.magFilter = THREE.NearestFilter
      particleTexture.minFilter = THREE.NearestFilter
      particleTexture.generateMipmaps = false
      
      const material = new THREE.MeshBasicMaterial({
        map: particleTexture,
        transparent: true,
        alphaTest: 0.01, // Even lower threshold for better visibility
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending, // Add glow effect
      })
      
      const mesh = new THREE.Mesh(geometry, material)
      mesh.userData = { texture: particleTexture, ctx: particleCtx, spriteIndex: i % 4 }
      this.meshes.push(mesh)
    }
    
    this.renderPlaceholder()
    void this.loadSpriteSheet()
  }
  
  update({ dt, camera }: TankAttackUpdateParams): void {
    if (!this.alive) return
    
    this.ageSeconds += dt
    if (this.ageSeconds >= this.buildDuration) {
      this.alive = false
      return
    }
    
    // Calculate build progress (0 to 1)
    const progress = this.ageSeconds / this.buildDuration
    const distance = this.actualDistance
    
    // Update particle positions in thick line formation
    for (let i = 0; i < this.particleCount; i++) {
      const particle = this.meshes[i]
      const particleProgress = (i / this.particleCount) * progress
      const particleDistance = distance * particleProgress
      
      // Position along the line
      particle.position.copy(this.startPos)
      particle.position.addScaledVector(this.direction, particleDistance)
      
      // Add random offset for thick line effect
      const thickness = 0.4
      const randomOffset = new THREE.Vector3()
      const perpendicular = new THREE.Vector3()
      
      if (Math.abs(this.direction.y) < 0.9) {
        perpendicular.crossVectors(this.direction, new THREE.Vector3(0, 1, 0))
      } else {
        perpendicular.crossVectors(this.direction, new THREE.Vector3(1, 0, 0))
      }
      perpendicular.normalize()
      
      const perpendicular2 = new THREE.Vector3().crossVectors(perpendicular, this.direction).normalize()
      
      randomOffset.addScaledVector(perpendicular, (Math.random() - 0.5) * thickness)
      randomOffset.addScaledVector(perpendicular2, (Math.random() - 0.5) * thickness)
      particle.position.add(randomOffset)
      
      // Billboard effect - face camera
      this.cameraPos.copy(camera.position)
      particle.lookAt(this.cameraPos)
      
      // Update particle texture based on assigned sprite
      if (this.spriteReady && this.sheet) {
        const userData = particle.userData as { spriteIndex: number; ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture }
        this.drawParticleFrame(userData.spriteIndex, userData.ctx, userData.texture)
      }
    }
  }

  tryHitPlayer(playerPos: THREE.Vector3, playerRadius: number, playerPadding = 0.1): boolean {
    if (!this.alive || this.hasDamagedPlayer) return false

    const denom = Math.max(this.buildDuration, 1e-6)
    const progress = THREE.MathUtils.clamp(this.ageSeconds / denom, 0, 1)
    const currentLength = this.actualDistance * progress

    this.tmp.subVectors(playerPos, this.startPos)
    const t = this.tmp.dot(this.direction)
    if (t < 0 || t > currentLength) return false

    this.tmp2.copy(this.startPos).addScaledVector(this.direction, t)
    const hitR = Math.max(0, playerRadius + playerPadding)
    if (this.tmp2.distanceToSquared(playerPos) <= hitR * hitR) {
      this.hasDamagedPlayer = true
      return true
    }

    return false
  }
  
  dispose(): void {
    for (const mesh of this.meshes) {
      const userData = mesh.userData as { texture: THREE.CanvasTexture }
      userData.texture.dispose()
      ;(mesh.material as THREE.Material).dispose()
      mesh.geometry.dispose()
    }
  }
  
  private async loadSpriteSheet(): Promise<void> {
    try {
      const img = await this.loadImage('/sprites/TankAttackParticles.png')
      this.sheet = new SpriteSheet(img, 16, 16, {
        frameCount: 4,
        framesPerRow: 4,
      })
      this.spriteReady = true
      
      // Initialize all particle textures with their assigned sprites
      for (const mesh of this.meshes) {
        const userData = mesh.userData as { spriteIndex: number; ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture }
        this.drawParticleFrame(userData.spriteIndex, userData.ctx, userData.texture)
      }
    } catch {
      // Keep placeholder if sprite load fails
    }
  }
  
  private drawParticleFrame(frame: number, ctx: CanvasRenderingContext2D, texture: THREE.CanvasTexture): void {
    if (!this.sheet) return
    
    ctx.clearRect(0, 0, 16, 16)
    this.sheet.drawFrame(ctx, frame, 0, 0, 1)
    texture.needsUpdate = true
  }
  
  private renderPlaceholder(): void {
    for (const mesh of this.meshes) {
      const userData = mesh.userData as { spriteIndex: number; ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture }
      const ctx = userData.ctx
      const texture = userData.texture
      
      ctx.clearRect(0, 0, 16, 16)
      texture.needsUpdate = true
    }
  }
  
  private calculateWallDistance(): void {
    // Raycast to find wall collision
    if (this.collisionMeshes.length > 0) {
      this.raycaster.set(this.startPos, this.direction)
      this.raycaster.far = 100 // Max distance
      
      const hits: THREE.Intersection[] = []
      this.raycaster.intersectObjects(this.collisionMeshes, false, hits)
      
      if (hits.length > 0) {
        this.actualDistance = hits[0].distance
      } else {
        // No wall hit, use max distance
        this.actualDistance = 50
      }
    } else {
      // No collision meshes, extend by 3x
      const originalDistance = this.startPos.distanceTo(this.targetPos)
      this.actualDistance = originalDistance * 3.0
    }
    
    // Update target position to the wall distance
    this.targetPos.copy(this.startPos).addScaledVector(this.direction, this.actualDistance)
  }
  
  private loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.decoding = 'async'
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`Failed to load image: ${src}`))
      img.src = src
    })
  }
}
