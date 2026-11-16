import SwiftUI

struct ConversationScrollAlignment: Equatable {
    private(set) var sequence: Int?
    private(set) var isAligned = false
    private var corrections = 0

    mutating func request(_ sequence: Int) {
        self.sequence = sequence; isAligned = false; corrections = 0
    }

    mutating func cancel() { self = Self() }

    mutating func correction(frames: [Int: CGRect], sequences: [Int], geometry: ScrollGeometry) -> CGFloat? {
        guard let sequence, let index = sequences.firstIndex(of: sequence) else { return nil }
        if let frame = frames[sequence] { return correction(frame: frame, geometry: geometry) }
        // A cold lazy stack can ignore an ID jump; seek between measured neighbors until the row exists.
        var lower = (index: -1, y: CGFloat.zero)
        var upper = (index: sequences.count, y: geometry.contentSize.height)
        for (sequence, frame) in frames {
            guard let measured = sequences.firstIndex(of: sequence) else { continue }
            let y = geometry.contentOffset.y + frame.minY
            if measured < index, measured > lower.index { lower = (measured, y) }
            if measured > index, measured < upper.index { upper = (measured, y) }
        }
        let fraction = CGFloat(index - lower.index) / CGFloat(upper.index - lower.index)
        let estimated = lower.y + fraction * (upper.y - lower.y)
        let offset = correction(frame: CGRect(x: 0, y: estimated - geometry.contentOffset.y, width: 1, height: 1), geometry: geometry)
        isAligned = false
        return offset
    }

    mutating func correction(frame: CGRect, geometry: ScrollGeometry) -> CGFloat? {
        guard sequence != nil, frame.minY.isFinite, geometry.containerSize.height > 0 else { return nil }
        let minimum = -geometry.contentInsets.top
        let maximum = max(minimum, geometry.contentSize.height - geometry.containerSize.height + geometry.contentInsets.bottom)
        let offset = min(maximum, max(minimum, geometry.contentOffset.y + frame.minY - geometry.contentInsets.top))
        isAligned = abs(offset - geometry.contentOffset.y) <= 1 && frame.intersects(CGRect(origin: .zero, size: geometry.containerSize))
        guard !isAligned, abs(offset - geometry.contentOffset.y) > 1 else { return nil }
        // Bound corrections if layout keeps changing; a new click gets a fresh budget.
        guard corrections < 8 else { return nil }
        corrections += 1
        return offset
    }
}

struct ConversationMessageFrames: PreferenceKey {
    static var defaultValue: [Int: CGRect] { [:] }
    static func reduce(value: inout [Int: CGRect], nextValue: () -> [Int: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}

extension View {
    func conversationMessageTarget(_ sequence: Int) -> some View {
        self.background {
            GeometryReader { geometry in
                Color.clear.preference(key: ConversationMessageFrames.self,
                                       value: [sequence: geometry.frame(in: .scrollView(axis: .vertical))])
            }
        }.id(sequence)
    }
}
