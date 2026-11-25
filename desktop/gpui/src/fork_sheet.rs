//! Shared chooser for the thread menu and /fork; never starts a model turn.
use crate::{
    app::Threadbear,
    call,
    style::{self, px, size},
};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{
    h_flex, v_flex, Disableable as _, Selectable as _, Sizable as _, StyledExt as _, WindowExt as _,
};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::sync::Arc;
use threadbear_client::runner::Client;
use threadbear_core::inbox::ThreadSummary;

impl Threadbear {
    pub(crate) fn conversation_forks_enabled(&self) -> bool {
        self.remote
            .experiments
            .iter()
            .any(|e| e == "conversationForks")
    }
    pub(crate) fn open_fork(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        self.open_fork_at(id, None, window, cx);
    }
    pub(crate) fn open_fork_at(
        &mut self,
        id: String,
        through_turn_id: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.conversation_forks_enabled() {
            self.show_error(
                "Conversation forks are turned off in Settings > General > Experiments.".into(),
                cx,
            );
            return;
        }
        if self.fork_sheet.is_some() {
            return;
        }
        let Some(source) = self.threads.get(&id).cloned() else {
            return;
        };
        let app = cx.entity().downgrade();
        let client = self.client.clone();
        let view = cx.new(|cx| ForkSheet::new(app, client, source, through_turn_id, window, cx));
        self.fork_sheet = Some(view.clone());
        let app = cx.entity().downgrade();
        window.open_dialog(cx, move |dialog, _, cx| {
            let app = app.clone();
            let creating = view.read(cx).creating;
            dialog
                .w(px(460.))
                .close_button(false)
                .overlay_closable(!creating)
                .keyboard(!creating)
                .child(view.clone())
                .footer(div())
                .on_close(move |_, _, cx| {
                    if let Some(app) = app.upgrade() {
                        app.update(cx, |app, cx| {
                            app.fork_sheet = None;
                            cx.notify();
                        });
                    }
                })
        });
        cx.notify();
    }
}

pub(crate) struct ForkSheet {
    app: WeakEntity<Threadbear>,
    client: Arc<Client>,
    source: Arc<ThreadSummary>,
    request_id: String,
    through_turn_id: Option<String>,
    info: Option<Value>,
    worktree: bool,
    asking: bool,
    creating: bool,
    attempted: bool,
    error: Option<String>,
}
impl ForkSheet {
    fn new(
        app: WeakEntity<Threadbear>,
        client: Arc<Client>,
        source: Arc<ThreadSummary>,
        through_turn_id: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut sheet = Self {
            app,
            client,
            source,
            request_id: uuid::Uuid::new_v4().to_string(),
            through_turn_id,
            info: None,
            worktree: false,
            asking: false,
            creating: false,
            attempted: false,
            error: None,
        };
        sheet.ask(window, cx);
        sheet
    }
    fn ask(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.asking || self.creating {
            return;
        }
        self.asking = true;
        self.error = None;
        let (client, id) = (self.client.clone(), self.source.id.clone());
        let mut params = json!({"threadId": id});
        if let Some(turn) = &self.through_turn_id {
            params["throughTurnId"] = json!(turn);
        }
        cx.spawn_in(window, async move |this, cx| {
            let answer = call(client, "threads.forkInfo", params).await;
            this.update_in(cx, |this, _, cx| {
                this.asking = false;
                match answer {
                    Ok(value) => this.info = Some(value),
                    Err(error) => this.error = Some(error.message),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
    fn can_create(&self) -> bool {
        !self.asking
            && !self.creating
            && self.info.as_ref().is_some_and(|i| {
                i["available"] == true && (!self.worktree || i["workspace"].is_object())
            })
    }
    fn close(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.close_dialog(cx);
        if let Some(app) = self.app.upgrade() {
            app.update(cx, |app, cx| {
                app.fork_sheet = None;
                cx.notify();
            });
        }
    }

    fn create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.can_create() {
            return;
        }
        self.creating = true;
        self.attempted = true;
        self.error = None;
        let client = self.client.clone();
        let mut params = json!({"threadId": self.source.id, "workspace": if self.worktree { "worktree" } else { "same" }, "requestId": self.request_id});
        if let Some(turn) = &self.through_turn_id {
            params["throughTurnId"] = json!(turn);
        }
        cx.spawn_in(window, async move |this, cx| {
            let answer = call(client, "threads.fork", params).await;
            this.update_in(cx, |this, window, cx| {
                this.creating = false;
                match answer {
                    Ok(value) => match serde_json::from_value::<ThreadSummary>(value["thread"].clone()).ok().filter(|t| !t.id.is_empty()) {
                        Some(mut child) => {
                            if child.runner_id.is_none() { child.runner_id = this.source.runner_id.clone(); }
                            if let Some(app) = this.app.upgrade() {
                                app.update(cx, |app, cx| {
                                    let id = child.id.clone();
                                    if child.runner_id.is_some() { app.remote.made.insert(id.clone()); }
                                    app.threads.insert(id.clone(), Arc::new(child));
                                    app.open(id, window, cx);
                                });
                            }
                            this.close(window, cx);
                        }
                        None => this.error = Some("The runner did not return the new thread. Retry to recover the same fork.".into()),
                    },
                    Err(error) => this.error = Some(error.message),
                }
                cx.notify();
            }).ok();
        }).detach();
        cx.notify();
    }
    fn excluded_files(&self) -> Option<String> {
        let paths: Vec<&str> = self
            .info
            .as_ref()?
            .get("workspace")?
            .get("untracked")?
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .collect();
        (self.worktree && !paths.is_empty()).then(|| {
            format!(
                "{} untracked files will stay out: {}",
                paths.len(),
                paths.join(", ")
            )
        })
    }
    #[cfg(feature = "automation")]
    pub(crate) fn dump(&self) -> Value {
        json!({"source": self.source.id, "throughTurnId": self.through_turn_id, "requestId": self.request_id, "workspace": if self.worktree { "worktree" } else { "same" }, "info": self.info, "asking": self.asking, "creating": self.creating, "error": self.error, "canFork": self.can_create(), "excludedFiles": self.excluded_files()})
    }
}
impl Render for ForkSheet {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let info = self.info.clone().unwrap_or(Value::Null);
        let workspace = &info["workspace"];
        let can_worktree = workspace.is_object();
        let blocked = info["reason"].as_str().map(str::to_owned);
        let waiting = self.asking || self.creating;
        let can_create = self.can_create();
        v_flex().gap(px(12.))
            .child(div().text_size(px(size::CARD_TITLE)).font_semibold().line_clamp(2).child(format!("Fork “{}”", self.source.title)))
            .child(div().text_size(px(size::LABEL)).text_color(style::secondary_text(cx)).child(if self.through_turn_id.is_some() { "Copy the conversation through this reply. Later replies stay out. Choose how its current files are shared." } else { "Copy the conversation into a new idle thread. Choose how its files are shared." }))
            .child(h_flex().gap(px(8.))
                .child(Button::new("fork-same").label("Same folder").small().outline().selected(!self.worktree).disabled(waiting || self.attempted).tooltip("An independent conversation using the same files").on_click(cx.listener(|this, _, _, cx| { this.worktree = false; cx.notify(); })))
                .child(Button::new("fork-worktree").label("New worktree").small().outline().selected(self.worktree).disabled(waiting || self.attempted || !can_worktree).tooltip("A separate Git worktree with the source revision and tracked edits").on_click(cx.listener(|this, _, _, cx| { this.worktree = true; cx.notify(); }))))
            .child(div().text_size(px(size::LABEL)).text_color(style::secondary_text(cx)).child(if self.worktree {
                format!("Separate files from {} at {}. Current tracked edits come with it. Untracked and ignored files stay out.", workspace["root"].as_str().unwrap_or(""), workspace["head"].as_str().unwrap_or(""))
            } else { format!("Shared files in {}. Changes made by either thread are visible to both.", self.source.cwd) }))
            .when(!can_worktree && !self.asking, |s| s.child(div().text_size(px(size::LABEL)).text_color(style::secondary_text(cx)).child("New worktree needs a Git repository and permission to use a separate folder.")))
            .when_some(self.excluded_files(), |s, text| s.child(div().id("fork-exclusions").max_h(px(120.)).overflow_y_scroll().text_size(px(size::LABEL)).text_color(style::secondary_text(cx)).child(text)))
            .when_some(blocked, |s, reason| s.child(div().text_size(px(size::LABEL)).text_color(style::failed(cx)).child(reason)))
            .when_some(self.error.clone(), |s, error| s.child(div().text_size(px(size::LABEL)).text_color(style::failed(cx)).child(error)))
            .child(h_flex().gap(px(8.)).items_center()
                .when(waiting, |s| s.child(Spinner::new().color(style::quiet_text(cx)).with_size(px(12.))).child(div().text_size(px(size::LABEL)).child(if self.creating { "Creating fork…" } else { "Checking conversation…" })))
                .child(div().flex_1())
                .child(Button::new("fork-cancel").label("Cancel").small().outline().disabled(self.creating).tooltip("Close without creating a fork").on_click(cx.listener(|this, _, window, cx| { if !this.creating { this.close(window, cx); } })))
                .when(!waiting && (info.is_null() || info["available"] != true), |s| s.child(Button::new("fork-check").label("Check again").small().outline().tooltip("Ask the runner whether this conversation can be forked").on_click(cx.listener(|this, _, window, cx| this.ask(window, cx)))))
                .child(Button::new("fork-create").label(if self.error.is_some() { "Retry fork" } else { "Fork" }).small().primary().disabled(!can_create).tooltip("Create the new thread without starting a model").on_click(cx.listener(|this, _, window, cx| this.create(window, cx)))))
    }
}
