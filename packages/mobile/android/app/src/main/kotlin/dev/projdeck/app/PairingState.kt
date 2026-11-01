package dev.projdeck.app

/** 配对进行中的状态，配对服务（前台）和无障碍服务（读配对码）之间共享。 */
object PairingState {
    /** 正在等待系统的「配对码配对」窗口出现。 */
    @Volatile var waiting = false

    /** 配对有结果时通知配对服务（成功、失败的说明）。 */
    @Volatile var onResult: ((String) -> Unit)? = null
}
