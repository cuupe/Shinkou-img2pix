use reqwest::{multipart, Client, Response};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_RESPONSE: usize = 32 * 1024 * 1024;

fn job_id(data: &Value) -> Result<&str, String> {
    let id = data["promptId"].as_str().ok_or("缺少任务编号")?;
    if id.is_empty() || id.len() > 80 || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
        return Err("无效任务编号".into());
    }
    Ok(id)
}

async fn read_response(mut response: Response) -> Result<Vec<u8>, String> {
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err("本地服务响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        let message = String::from_utf8_lossy(&bytes);
        return Err(format!(
            "本地生图服务返回 {}：{}",
            status.as_u16(),
            message.chars().take(1200).collect::<String>()
        ));
    }
    Ok(bytes)
}

/// Only this fixed loopback service and a small set of ComfyUI routes are exposed.
/// No arbitrary URLs, proxy, redirects, model execution paths or shell commands.
#[tauri::command]
pub async fn generation_request(
    operation: String,
    data: Value,
    image: Option<Vec<u8>>,
) -> Result<Value, String> {
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let base = "http://127.0.0.1:8188";
    let request = match operation.as_str() {
        "info" => client.get(format!("{base}/object_info")),
        "upload" => {
            let bytes = image.ok_or("缺少参考图片")?;
            if bytes.len() > 16 * 1024 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                return Err("参考图必须为不超过 16 MB 的 PNG".into());
            }
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos();
            let file = multipart::Part::bytes(bytes)
                .file_name(format!("shinkou-{stamp}.png"))
                .mime_str("image/png")
                .map_err(|e| e.to_string())?;
            client.post(format!("{base}/upload/image")).multipart(
                multipart::Form::new()
                    .part("image", file)
                    .text("type", "input"),
            )
        }
        "submit" => {
            if data.to_string().len() > 128 * 1024 {
                return Err("工作流过大".into());
            }
            client.post(format!("{base}/prompt")).json(&data)
        }
        "history" => client.get(format!("{base}/history/{}", job_id(&data)?)),
        "cancel" => client
            .post(format!("{base}/queue"))
            .json(&json!({"delete": [job_id(&data)?]})),
        "image" => {
            let filename = data["filename"].as_str().ok_or("缺少输出图片")?;
            let subfolder = data["subfolder"].as_str().unwrap_or("");
            let kind = data["type"].as_str().unwrap_or("output");
            if !matches!(kind, "output" | "temp") || filename.len() > 255 || subfolder.len() > 255 {
                return Err("无效输出图片".into());
            }
            client.get(format!("{base}/view")).query(&[
                ("filename", filename),
                ("subfolder", subfolder),
                ("type", kind),
            ])
        }
        _ => return Err("不支持的生图操作".into()),
    };
    let response = request
        .send()
        .await
        .map_err(|_| "无法连接本地生图服务（127.0.0.1:8188）。请先启动 ComfyUI。".to_string())?;
    let bytes = read_response(response).await?;
    if operation == "image" {
        Ok(json!({"bytes": bytes}))
    } else if bytes.is_empty() {
        Ok(json!({}))
    } else {
        serde_json::from_slice(&bytes).map_err(|_| "本地服务返回了无效数据".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn job_identifiers_cannot_change_request_route() {
        assert!(job_id(&json!({"promptId":"feda-1234"})).is_ok());
        for id in ["", "../queue", "123?delete=1", "http://example.com"] {
            assert!(job_id(&json!({"promptId":id})).is_err());
        }
    }
}
