import os
import random
import string
from pathlib import Path

def generate_random_string(length=10):
    """生成随机字符串"""
    letters = string.ascii_letters
    return ''.join(random.choice(letters) for _ in range(length))

def generate_random_content(min_lines=1, max_lines=20):
    """生成随机文本内容"""
    num_lines = random.randint(min_lines, max_lines)
    content = []
    for _ in range(num_lines):
        line_length = random.randint(10, 100)
        content.append(generate_random_string(line_length))
    return '\n'.join(content)

def create_complex_structure(base_path, depth=0, max_depth=5):
    """递归创建复杂文件夹结构"""
    if depth > max_depth:
        return
    
    # 创建1-5个随机文件夹
    num_folders = random.randint(1, 5)
    for i in range(num_folders):
        folder_name = f"folder_{generate_random_string(5)}_{depth}_{i}"
        folder_path = os.path.join(base_path, folder_name)
        os.makedirs(folder_path, exist_ok=True)
        
        # 在每个文件夹中创建1-3个随机文本文件
        num_files = random.randint(1, 3)
        for j in range(num_files):
            file_name = f"file_{generate_random_string(5)}_{j}.txt"
            file_path = os.path.join(folder_path, file_name)
            with open(file_path, 'w') as f:
                f.write(generate_random_content())
        
        # 随机决定是否创建更深层次的子文件夹
        if random.random() < 0.7:  # 70%的概率继续创建子文件夹
            create_complex_structure(folder_path, depth+1, max_depth)

def main():
    print("正在创建复杂的文件夹结构...")
    base_dir = "complex_structure"
    os.makedirs(base_dir, exist_ok=True)
    
    # 创建主结构
    create_complex_structure(base_dir)
    
    # 添加一些特殊文件夹和文件
    special_folders = [
        "empty_folder",
        "deeply/nested/folder/structure",
        "mixed_content/images_and_text",
        "project/src/main/resources",
        "project/docs/archive/2023/reports"
    ]
    
    for folder in special_folders:
        path = os.path.join(base_dir, folder)
        os.makedirs(path, exist_ok=True)
        
        # 在某些特殊文件夹中添加文件
        if "mixed_content" in folder:
            with open(os.path.join(path, "notes.txt"), 'w') as f:
                f.write("这是一个混合内容文件夹，可能包含各种文件类型。\n" + generate_random_content())
        
        if "project" in folder and "docs" in folder:
            for i in range(3):
                with open(os.path.join(path, f"report_{i}.txt"), 'w') as f:
                    f.write(f"项目报告 #{i}\n" + generate_random_content(5, 10))
    
    print(f"复杂的文件夹结构已创建在 '{base_dir}' 目录下。")

if __name__ == "__main__":
    main()