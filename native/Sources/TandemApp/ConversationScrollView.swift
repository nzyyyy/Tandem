import SwiftUI
import Combine
import TandemCore

struct ConversationViewport: Equatable {
    var visibleSequence: Int?
    var isNearBottom = true
    var isAtBottom = false
}

private struct ConversationScrollObservation: Equatable {
    var viewport = ConversationViewport()
    var geometry: ScrollGeometry?
    var frames: [Int: CGRect] = [:]
}

struct ConversationScrollView<Content: View>: View {
    @Binding var position: ScrollPosition
    var messages: [TimelineMessage]
    var lastSequence: Int?
    var ready: Bool
    var sending: Bool
    var navigationHeight: CGFloat
    var savePosition: (ConversationViewport) -> Void
    var onScrollSettled: () -> Void = {}
    @ViewBuilder var content: Content
    @State private var viewport = ConversationViewport()
    @State private var alignment = ConversationScrollAlignment()
    @State private var observations = CurrentValueSubject<ConversationScrollObservation, Never>(ConversationScrollObservation())
    @State private var jumpSettling = false
    @State private var jumpRetry: Task<Void, Never>?

    var body: some View {
        ScrollView { content }
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .scrollPosition($position)
            .onScrollGeometryChange(for: ScrollGeometry.self) { $0 } action: { _, geometry in
                var next = observations.value
                next.geometry = geometry
                let remaining = geometry.contentSize.height - geometry.visibleRect.maxY
                next.viewport.isNearBottom = remaining < 80
                next.viewport.isAtBottom = remaining <= 1
                observations.send(next)
            }
            .onScrollTargetVisibilityChange(idType: Int.self, threshold: 0.01) { sequences in
                var next = observations.value; next.viewport.visibleSequence = sequences.min()
                observations.send(next)
            }
            .onPreferenceChange(ConversationMessageFrames.self) { frames in
                var next = observations.value; next.frames = frames
                observations.send(next)
            }
            .onChange(of: position.viewID(type: Int.self), initial: true) { _, sequence in
                // Only an externally driven jump (launch restore) starts a new alignment. While one
                // is active, corrections themselves can change the top-visible row; re-arming for
                // those changes would loop forever.
                guard let sequence, alignment.sequence == nil else { return }
                beginAlignment(sequence)
            }
            .onChange(of: position.edge) { _, edge in
                if edge != nil { alignment.cancel() }
            }
            .onScrollPhaseChange { _, phase in
                if phase == .tracking || phase == .interacting || phase == .decelerating { alignment.cancel() }
            }
            .onChange(of: position.isPositionedByUser) { _, userPosition in
                if userPosition { alignment.cancel() }
            }
            .onChange(of: sending) { _, sending in
                if sending { alignment.cancel() }
            }
            .onChange(of: messages.map(\.sequence)) { _, sequences in
                if let sequence = alignment.sequence, !sequences.contains(sequence) { alignment.cancel() }
            }
            .onChange(of: lastSequence) { _, sequence in
                if ready, alignment.sequence == nil || alignment.isAligned || sending,
                   sequence != nil, viewport.isNearBottom || sending {
                    alignment.cancel()
                    position.scrollTo(edge: .bottom)
                }
            }
            .onReceive(observations.removeDuplicates().throttle(for: .milliseconds(16), scheduler: RunLoop.main, latest: true)) { next in
                // Layout callbacks only collect observations; publish once after the layout pass settles.
                let changed = viewport != next.viewport
                if changed { viewport = next.viewport }
                if changed, alignment.sequence == nil || alignment.isAligned {
                    savePosition(next.viewport)
                }
            }
            .onReceive(observations.removeDuplicates().debounce(for: .milliseconds(16), scheduler: RunLoop.main).receive(on: RunLoop.main)) { next in
                // Frame preferences and scroll geometry arrive separately; correct only after both settle.
                let wasAligned = alignment.isAligned
                correctAlignment(next)
                if !wasAligned, alignment.isAligned { savePosition(next.viewport) }
            }
            .onReceive(observations.removeDuplicates().debounce(for: .milliseconds(300), scheduler: RunLoop.main).receive(on: RunLoop.main)) { _ in
                // Lazy-row measurements and alignment corrections have stopped moving the list.
                onScrollSettled()
            }
            .overlay(alignment: .leading) {
                ConversationNavigation(messages: messages, visibleSequence: viewport.visibleSequence,
                                       maximumHeight: navigationHeight, isAtBottom: viewport.isAtBottom) { sequence in
                    // A single, nonanimated target replaces earlier clicks instead of stacking scroll animations.
                    beginAlignment(sequence)
                    position.scrollTo(id: sequence, anchor: .top)
                }.padding(.leading, 4)
            }
    }

    // Let the ID jump and the lazy rows settle before correcting with a possibly stale layout.
    private func beginAlignment(_ sequence: Int) {
        alignment.request(sequence)
        jumpSettling = true
        jumpRetry?.cancel()
        jumpRetry = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled else { return }
            jumpSettling = false
            correctAlignment(observations.value)
        }
    }

    private func correctAlignment(_ observation: ConversationScrollObservation) {
        guard let geometry = observation.geometry else { return }
        // Before the target row has measured, only an estimate is available; correcting with it
        // overshoots and reverses. Give the native ID jump time to land, then seek if it missed.
        if jumpSettling, let sequence = alignment.sequence, observation.frames[sequence] == nil { return }
        var updated = alignment
        let offset = updated.correction(frames: observation.frames, sequences: messages.map(\.sequence), geometry: geometry)
        if updated != alignment { alignment = updated }
        if let offset { position.scrollTo(y: offset) }
    }
}
