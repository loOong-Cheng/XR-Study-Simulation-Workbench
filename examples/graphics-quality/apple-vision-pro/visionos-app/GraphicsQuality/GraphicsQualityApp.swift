// Graphics Quality Room for Apple Vision Pro: the visionOS port of the WebXR study app in
// examples/graphics-quality/webxr-app. The app opens directly into a full immersive space
// (Info.plist: UIApplicationPreferredDefaultSceneSessionRole = UISceneSessionRoleImmersiveSpaceApplication).
import RealityKit
import SwiftUI

@main
struct GraphicsQualityApp: App {
    @State private var model = StudyModel.shared
    @State private var immersionStyle: any ImmersionStyle = .full

    var body: some SwiftUI.Scene {
        ImmersiveSpace(id: "room") {
            ImmersiveView()
                .environment(model)
        }
        .immersionStyle(selection: $immersionStyle, in: .full)
    }
}

struct ImmersiveView: View {
    @Environment(StudyModel.self) private var model

    var body: some View {
        RealityView { content, attachments in
            await StudyModel.shared.makeScene(&content, attachments)
        } attachments: {
            Attachment(id: "panel") {
                TaskPanel()
                    .environment(model)
            }
        }
        .gesture(
            SpatialTapGesture()
                .targetedToAnyEntity()
                .onEnded { value in model.tapped(value.entity) }
        )
    }
}

/// Head-locked task panel, like the WebXR overlay (title, instruction, status, hint).
struct TaskPanel: View {
    @Environment(StudyModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(model.panelTitle)
                .font(.system(size: 30, weight: .bold))
            if !model.instruction.isEmpty {
                Text(model.instruction)
                    .font(.system(size: 24))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !model.statusLine.isEmpty {
                Text(model.statusLine)
                    .font(.system(size: 20))
                    .foregroundStyle(Color(white: 0.8))
            }
            if model.trial < 0 {
                Button("Start practice") { model.startFromPanel() }
                    .font(.system(size: 20, weight: .semibold))
                    .tint(Color(red: 0.17, green: 0.41, blue: 0.31))
            }
            Text("Look around and pinch objects to select them.")
                .font(.system(size: 18))
                .foregroundStyle(Color(white: 0.73))
        }
        .foregroundStyle(.white)
        .padding(24)
        .frame(width: 600, alignment: .leading)
        .background(Color.black.opacity(0.65), in: RoundedRectangle(cornerRadius: 22))
    }
}
