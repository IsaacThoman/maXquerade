import * as THREE from 'three'
import { Enemy } from './Enemy'

export type GamePhase = 'intro' | 'playing' | 'enemy-defeated' | 'fade-out' | 'fade-in' | 'restarting'

export interface EnemyConfig {
  type: 0 | 1
  position: THREE.Vector3
  state: 'idle' | 'pursuing'
}

export interface LevelConfig {
  enemies: EnemyConfig[]
  waitForPlayerMovement: boolean
}

export type FadeReason = 'level-advance' | 'player-death' | null

export class GameLoop {
  currentLevel = 0
  phase: GamePhase = 'intro'
  phaseTimer = 0
  
  // Level configurations - expandable for future levels
  levels: LevelConfig[] = [
    // Level 1: Single type 0 enemy
    {
      enemies: [
        { type: 0, position: new THREE.Vector3(0, 3.0, -20), state: 'idle' }
      ],
      waitForPlayerMovement: true
    },
    // Level 2: 2 type 0 + 1 type 1 (your original setup)
    {
      enemies: [
        { type: 0, position: new THREE.Vector3(0, 3.0, -20), state: 'idle' },
        { type: 0, position: new THREE.Vector3(22, 3.0, -27), state: 'idle' },
        { type: 1, position: new THREE.Vector3(22, 3.0, -13), state: 'pursuing' }
      ],
      waitForPlayerMovement: true
    },
    // Level 3: 3 enemies (2 type 0 + 1 type 1) at different positions
    {
      enemies: [
        { type: 0, position: new THREE.Vector3(-10, 3.0, -25), state: 'idle' },
        { type: 0, position: new THREE.Vector3(15, 3.0, -30), state: 'idle' },
        { type: 1, position: new THREE.Vector3(15, 3.0, -18), state: 'pursuing' }
      ],
      waitForPlayerMovement: true
    }
  ]
  
  // Track if player has moved
  playerHasMoved = false
  lastPlayerPosition = new THREE.Vector3()
  
  // Enemy tracking - supports multiple enemies per level
  currentEnemies: Enemy[] = []
  enemyDefeated = false
  
  // Fade effects - slower for cinematic feel
  fadeAlpha = 0
  fadeSpeed = 0.4 // Slower fade (was 1.5)

  fadeReason: FadeReason = null
  
  // Event callbacks
  onEnemyDefeated: (() => void) | null = null
  onMaskPickup: (() => void) | null = null
  onLevelComplete: (() => void) | null = null
  onFadeComplete: (() => void) | null = null
  onRestartLevel: (() => void) | null = null
  onDoorOpen: (() => void) | null = null
  
  update(dt: number, playerPosition: THREE.Vector3): void {
    this.phaseTimer += dt
    
    switch (this.phase) {
      case 'intro':
        // Wait for player to move
        if (!this.playerHasMoved) {
          const distance = playerPosition.distanceTo(this.lastPlayerPosition)
          if (distance > 0.1) {
            this.playerHasMoved = true
            this.phase = 'playing'
          }
        }
        this.lastPlayerPosition.copy(playerPosition)
        break
        
      case 'playing':
        // Simple logic: check if all enemies are defeated
        const allEnemiesDefeated = this.currentEnemies.length > 0 && 
          this.currentEnemies.every(enemy => !enemy.alive)
        if (allEnemiesDefeated && !this.enemyDefeated) {
          this.enemyDefeated = true
          this.phase = 'enemy-defeated'
          this.phaseTimer = 0
          this.onEnemyDefeated?.()
        }
        break
        
      case 'enemy-defeated':
        // Wait for player to pick up the mask that the enemy dropped
        // The mask pickup will trigger the fade-out
        break
        
      case 'fade-out':
        this.fadeAlpha = Math.min(this.fadeAlpha + this.fadeSpeed * dt, 1)
        if (this.fadeAlpha >= 1) {
          console.log('FADE TO BLACK COMPLETE - Transitioning to restarting phase')
          this.phase = 'restarting'
          this.phaseTimer = 0
        }
        break
        
      case 'restarting':
        // Call the completion callback ONCE at the start of black screen
        // Check if this is the first frame (phaseTimer will be < dt since it was just set to 0)
        if (this.phaseTimer < 0.1) {
          const label = this.fadeReason === 'player-death' ? 'Restarting level' : 'Opening door and setting up next level'
          console.log(`BLACK SCREEN START - ${label} NOW`)
          try {
            if (this.fadeReason === 'player-death') {
              this.onRestartLevel?.()
              console.log('onRestartLevel executed successfully')
            } else {
              this.onFadeComplete?.()
              console.log('onFadeComplete executed successfully')
            }
          } catch (e) {
            console.error('ERROR in onFadeComplete:', e)
          }
        }
        // Keep screen black for 1.5 seconds showing animation, then fade in
        if (this.phaseTimer > 1.5) {
          console.log('FADING BACK IN...')
          this.phase = 'fade-in'
          this.phaseTimer = 0
        }
        break
        
      case 'fade-in':
        this.fadeAlpha = Math.max(this.fadeAlpha - this.fadeSpeed * dt, 0)
        if (this.fadeAlpha <= 0) {
          this.phase = 'intro'
          this.playerHasMoved = false
          this.enemyDefeated = false
          this.fadeReason = null
        }
        break
    }
  }
  
  triggerMaskPickup(): void {
    console.log('triggerMaskPickup called, current phase:', this.phase)
    if (this.phase === 'playing' || this.phase === 'enemy-defeated') {
      console.log('Phase is valid, setting to fade-out')
      this.fadeReason = 'level-advance'
      this.phase = 'fade-out'
      this.phaseTimer = 0
      this.onMaskPickup?.()
      console.log('Phase is now:', this.phase)
    } else {
      console.log('ERROR: Cannot trigger mask pickup from phase:', this.phase)
    }
  }

  triggerPlayerDeath(): void {
    if (this.phase === 'fade-out' || this.phase === 'fade-in' || this.phase === 'restarting') return
    this.fadeReason = 'player-death'
    this.phase = 'fade-out'
    this.phaseTimer = 0
  }
  
  startNextLevel(): void {
    this.currentLevel++
    if (this.currentLevel >= this.levels.length) {
      this.currentLevel = 0 // Loop back to start or handle game completion
    }
    this.phase = 'fade-in'
    this.phaseTimer = 0
    this.onLevelComplete?.()
  }
  
  getCurrentLevelConfig(): LevelConfig {
    return this.levels[this.currentLevel]
  }
  
  shouldEnemyWait(): boolean {
    const config = this.getCurrentLevelConfig()
    return config.waitForPlayerMovement && !this.playerHasMoved
  }
  
  reset(): void {
    this.phase = 'intro'
    this.phaseTimer = 0
    this.playerHasMoved = false
    this.enemyDefeated = false
    this.currentEnemies = []
    this.fadeAlpha = 0
    this.lastPlayerPosition.set(0, 0, 0)
  }
}
